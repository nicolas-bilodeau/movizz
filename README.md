# Movizz

Choisir le prochain film à regarder, à deux.

- **Backlog** : n'importe quel film via TMDB, avec une origine (« Oscars 2025 », « Palme d'or »…), ou import d'une liste (CSV IMDb / Letterboxd, ou un titre par ligne).
- **Au hasard** : tirage dans le backlog selon l'humeur, le genre, l'origine, la durée et vos plateformes.
- **Selon le dernier film vu** : même lignée, tout le contraire, même réalisation, acteur principal, actrice principale. On cherche dans le backlog, dans les listes références (TSPDT, Rotten Tomatoes, IMDb Top 1000, listes importées) ou dans tout TMDB.
- **Disponibilité au Canada** : les plateformes de chaque film (données JustWatch via TMDB), et un filtre « seulement sur mes plateformes ».

## Utiliser

L'app est un site statique, sans serveur ni compilation. Il faut une clé TMDB gratuite ([themoviedb.org › Paramètres › API](https://www.themoviedb.org/settings/api)), à coller dans l'onglet Réglages. Elle reste dans le navigateur.

Les données (backlog, vus, plateformes) sont gardées dans le navigateur. Exporter / Importer (onglet Réglages) permet de les déplacer ou de fusionner deux backlogs.

## Foyer partagé (Supabase)

Pour partager le backlog entre appareils et entre personnes, l'app se connecte à un projet Supabase (`js/config.js` : URL du projet et clé *publishable*, publiques par conception).

1. Dans Supabase › SQL Editor, exécuter `supabase/schema.sql` (tables, règles d'accès par foyer, mises à jour en direct).
2. Dans Authentication › URL Configuration, mettre l'adresse du site comme Site URL.
3. Dans l'app, Réglages › Foyer partagé : se connecter par courriel, créer le foyer, puis donner le code d'invitation à l'autre personne.

Chaque appareil garde une copie locale et envoie ses changements ; le plus récent l'emporte. La clé TMDB et les plateformes sont partagées dans le foyer.

## Développer

```sh
npm start          # sert le site sur http://localhost:8080
npm install && npm test   # test navigateur avec TMDB et Supabase simulés (Playwright)
```

- `js/tmdb.js` : client TMDB
- `js/reco.js` : moteur de recommandation
- `js/store.js` : stockage local, export / import
- `js/sync.js` : synchronisation du foyer avec Supabase
- `js/main.js` : interface
- `data/catalogue.json` : listes références (TSPDT top 200, Rotten Tomatoes 300, IMDb Top 1000)

Ce produit utilise l'API TMDB mais n'est ni approuvé ni certifié par TMDB.
