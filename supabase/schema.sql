-- Movizz : backlog partagé d'un « foyer » (vous et les personnes que vous invitez).
-- À coller une fois dans Supabase › SQL Editor › New query, puis « Run ». Peut être relancé sans danger.

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Notre foyer',
  code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 6)),
  settings jsonb not null default '{}'::jsonb,   -- plateformes, location, clé TMDB
  settings_u bigint not null default 0,          -- horodatage (ms) de la dernière modification
  created_at timestamptz not null default now()
);

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

-- Créer un foyer : la personne connectée en devient membre.
create or replace function public.create_household(p_name text default null) returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  insert into public.households (name) values (coalesce(nullif(trim(p_name), ''), 'Notre foyer')) returning * into h;
  insert into public.members (household_id, user_id, email) values (h.id, auth.uid(), auth.jwt() ->> 'email');
  return h;
end $$;

-- Rejoindre un foyer avec son code d'invitation.
create or replace function public.join_household(p_code text) returns public.households
language plpgsql security definer set search_path = public as $$
declare h public.households;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into h from public.households where code = upper(trim(p_code));
  if h.id is null then raise exception 'Code inconnu'; end if;
  insert into public.members (household_id, user_id, email) values (h.id, auth.uid(), auth.jwt() ->> 'email')
    on conflict do nothing;
  return h;
end $$;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant select, update on public.households to authenticated;
grant select, delete on public.members to authenticated;
grant select, insert, update, delete on public.films, public.lists to authenticated;

-- Mises à jour en direct entre les appareils.
do $$
declare t text;
begin
  foreach t in array array['films', 'lists', 'households'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
