# Fourmilière (ant colony simulator)

Un simulateur de colonie de fourmis en pixel art 2D, puis en voxel 3D, qui tourne entièrement dans le navigateur. On joue une fourmi (creuser, porter, fourrager, combattre) et on gère toute la colonie, avec un mode dieu par-dessus.

Le plan complet et la liste des fonctionnalités sont dans le document de projet sur Claude.

## Jouer

- **Sans rien installer** : télécharger `index.html` depuis l'artefact « fourmiliere-un-fichier » d'une exécution de la CI (onglet Actions), puis l'ouvrir par double-clic.
- **En développement** :

```sh
npm install
npm run dev          # serveur local avec rechargement à chaud
npm test             # tests de la simulation
npm run build        # version web dans dist/
npm run build:single # un seul fichier HTML jouable hors ligne dans dist-single/
```

## Contrôles

| Touche | Action |
| --- | --- |
| ZQSD / WASD / flèches | Se déplacer et viser |
| Espace maintenu | Creuser la case visée |
| E | Déposer ce que la fourmi porte |
| F | Manger la nourriture portée (+3 à la réserve) |
| 1 / 2 / 3 / 4 | Pondre un œuf d'ouvrière, de soldat, de reine ou de mâle (la reine seulement) |
| V | Voir les phéromones : pistes de nourriture en vert, alarme en rouge |
| T | Choisir ce que devient la terre creusée : remonte à la surface, disparaît, ou à porter soi-même |
| Clic gauche sur une case voisine | Creuser (maintenu) ou déposer |
| Molette | Zoom |
| P / Échap | Pause |
| N | Nouveau monde |
| H | Cacher l'aide |

Ajouter `?seed=1234` à l'adresse pour rejouer le même monde.

## Architecture

```
src/core/    simulation partagée : grille du monde, fourmis, règles. Aucun code d'affichage.
src/game2d/  jeu 2D : rendu PixiJS, contrôles, interface
test/        tests Vitest de la simulation
```

Le monde est toujours une grille 3D de cellules ; la version 2D utilise une profondeur de 1, la version voxel réutilisera le même cœur. Les fourmis sont stockées dans des tableaux typés pour pouvoir passer à des milliers. La simulation avance à pas fixe (30 par seconde) et est déterministe : même graine et mêmes entrées donnent le même monde.
