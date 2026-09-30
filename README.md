# Movizz

Choisir le prochain film à regarder, à deux.

- **Backlog** : n'importe quel film via TMDB, avec une origine (« Oscars 2025 », « Palme d'or »…), ou import d'une liste (CSV IMDb / Letterboxd, ou un titre par ligne).
- **Au hasard** : tirage dans le backlog selon l'humeur, le genre, l'origine, la durée et vos plateformes.
- **Selon le dernier film vu** : même lignée, tout le contraire, même réalisation, acteur principal, actrice principale. On cherche dans le backlog, dans les listes références (TSPDT, Rotten Tomatoes, listes importées) ou dans tout TMDB.
- **Disponibilité au Canada** : les plateformes de chaque film (données JustWatch via TMDB), et un filtre « seulement sur mes plateformes ».

## Utiliser

L'app est un site statique, sans serveur ni compilation. Il faut une clé TMDB gratuite ([themoviedb.org › Paramètres › API](https://www.themoviedb.org/settings/api)), à coller dans l'onglet Réglages. Elle reste dans le navigateur.

Les données (backlog, vus, plateformes) sont gardées dans le navigateur. Exporter / Importer (onglet Réglages) permet de les déplacer ou de fusionner deux backlogs.

## Développer

```sh
npm start          # sert le site sur http://localhost:8080
npm install && npm test   # test navigateur avec un TMDB simulé (Playwright)
```

- `js/tmdb.js` : client TMDB
- `js/reco.js` : moteur de recommandation
- `js/store.js` : stockage local, export / import
- `js/main.js` : interface
- `data/catalogue.json` : listes références (TSPDT top 200, Rotten Tomatoes 300)

Ce produit utilise l'API TMDB mais n'est ni approuvé ni certifié par TMDB.
