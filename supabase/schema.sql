-- Movizz : backlog partagé d'un « foyer » (vous et les personnes que vous invitez).
-- À coller dans Supabase › SQL Editor › New query, puis « Run ». Peut être relancé sans danger
-- (à refaire après chaque mise à jour de ce fichier).
-- On entre dans un foyer avec son code et son mot de passe ; chaque appareil a une session anonyme
-- (Authentication › Sign In / Providers › « Allow anonymous sign-ins » doit être activé).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Notre foyer',
  code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  settings jsonb not null default '{}'::jsonb,   -- plateformes, location, clé TMDB
  settings_u bigint not null default 0,          -- horodatage (ms) de la dernière modification
  created_at timestamptz not null default now()
);
alter table public.households add column if not exists password_hash text;  -- bcrypt, jamais lisible par l'app
alter table public.households add column if not exists has_password boolean generated always as (password_hash is not null) stored;

create table if not exists public.members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email text,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Un film par ligne ; data contient la fiche et le statut (backlog / vu), ou {"deleted": true}.
create table if not exists public.films (
  household_id uuid not null references public.households (id) on delete cascade,
  id integer not null,
  data jsonb not null,
  u bigint not null,                              -- horodatage (ms) du changement, côté appareil
  at timestamptz not null default clock_timestamp(), -- heure d'écriture, côté serveur
  primary key (household_id, id)
);
create index if not exists films_at on public.films (household_id, at);

-- Listes références importées.
create table if not exists public.lists (
  household_id uuid not null references public.households (id) on delete cascade,
  id text not null,
  data jsonb not null,
  u bigint not null,
  at timestamptz not null default clock_timestamp(),
  primary key (household_id, id)
);
create index if not exists lists_at on public.lists (household_id, at);

-- Chaque écriture reçoit l'heure du serveur, pour que les appareils ne récupèrent que les nouveautés.
create or replace function public.stamp_at() returns trigger language plpgsql as $$
begin new.at := clock_timestamp(); return new; end $$;
drop trigger if exists films_at on public.films;
create trigger films_at before insert or update on public.films for each row execute function public.stamp_at();
drop trigger if exists lists_at on public.lists;
create trigger lists_at before insert or update on public.lists for each row execute function public.stamp_at();

create or replace function public.is_member(h uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where household_id = h and user_id = auth.uid());
$$;

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.films enable row level security;
alter table public.lists enable row level security;

drop policy if exists "membres lisent" on public.households;
create policy "membres lisent" on public.households for select to authenticated using (public.is_member(id));
drop policy if exists "membres modifient" on public.households;
create policy "membres modifient" on public.households for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

drop policy if exists "membres se voient" on public.members;
create policy "membres se voient" on public.members for select to authenticated using (public.is_member(household_id));
drop policy if exists "quitter le foyer" on public.members;
create policy "quitter le foyer" on public.members for delete to authenticated using (user_id = auth.uid());

drop policy if exists "films du foyer" on public.films;
create policy "films du foyer" on public.films for all to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));
drop policy if exists "listes du foyer" on public.lists;
create policy "listes du foyer" on public.lists for all to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));

-- Un appareil n'appartient qu'à un foyer à la fois.
drop function if exists public.create_household(text);
drop function if exists public.join_household(text);

-- Créer un foyer protégé par un mot de passe : l'appareil connecté en devient membre.
create or replace function public.create_household(p_name text, p_password text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare hid uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'Mot de passe trop court'; end if;
  insert into public.households (name, password_hash)
    values (coalesce(nullif(trim(p_name), ''), 'Notre foyer'), crypt(p_password, gen_salt('bf')))
    returning id into hid;
  delete from public.members where user_id = auth.uid();
  insert into public.members (household_id, user_id, email) values (hid, auth.uid(), auth.jwt() ->> 'email');
  return hid;
end $$;

-- Rejoindre un foyer avec son code et son mot de passe.
create or replace function public.join_household(p_code text, p_password text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into h from public.households where code = upper(trim(p_code));
  if h.id is not null and h.password_hash is null then raise exception 'Pas de mot de passe'; end if;
  if h.id is null or h.password_hash <> crypt(coalesce(p_password, ''), h.password_hash) then
    perform pg_sleep(1);
    raise exception 'Code ou mot de passe incorrect';
  end if;
  delete from public.members where user_id = auth.uid() and household_id <> h.id;
  insert into public.members (household_id, user_id, email) values (h.id, auth.uid(), auth.jwt() ->> 'email')
    on conflict do nothing;
  return h.id;
end $$;

-- Définir ou changer le mot de passe du foyer (réservé à ses membres).
create or replace function public.set_household_password(p_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_password, '')) < 6 then raise exception 'Mot de passe trop court'; end if;
  update public.households set password_hash = crypt(p_password, gen_salt('bf')) where public.is_member(id);
end $$;

revoke all on function public.create_household(text, text) from public, anon;
revoke all on function public.join_household(text, text) from public, anon;
revoke all on function public.set_household_password(text) from public, anon;
grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.set_household_password(text) to authenticated;
-- L'app lit tout sauf le mot de passe.
revoke select, update on public.households from authenticated, anon;
grant select (id, name, code, settings, settings_u, has_password, created_at) on public.households to authenticated;
grant update (name, settings, settings_u) on public.households to authenticated;
grant select, delete on public.members to authenticated;
grant select, insert, update, delete on public.films, public.lists to authenticated;

-- Mises à jour en direct entre les appareils.
do $$
declare t text;
begin
  foreach t in array array['films', 'lists'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
  -- households n'est plus diffusé (le mot de passe n'y est pas lisible) : les réglages suivent à la synchro suivante.
  begin
    alter publication supabase_realtime drop table public.households;
  exception when others then null;
  end;
end $$;
