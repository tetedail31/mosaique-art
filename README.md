# Mosaïque — reconstruis un tableau avec tes photos

Outil web statique : tu déposes tes photos, tu choisis un tableau célèbre, l'outil assemble une
mosaïque photographique et te rend un fichier PNG ou JPEG prêt à imprimer.

**Tout se calcule dans le navigateur.** Aucune photo n'est téléversée, aucun serveur, aucune clé,
aucun compte. Le dépôt ne contient que du code et douze images du domaine public.

## Utilisation

1. Déposer les photos (glisser-déposer ou sélection).
2. Choisir un tableau, ou importer sa propre image cible.
3. Régler la largeur du fichier et la taille des photos dans la grille.
4. Générer, puis télécharger le PNG (impression) ou le JPEG (partage).

## Comment ça marche

- Chaque photo est réduite à la taille d'une tuile, puis résumée par sa moyenne et son écart-type
  colorimétriques.
- La cible est découpée en cases de même taille, résumées de la même façon.
- L'appariement se fait en CIELAB : la distance privilégie la luminance, la chrominance pèse 1,35×.
- Chaque case reçoit la photo la plus proche. Par défaut chaque photo n'est utilisée qu'une fois ;
  si la grille demande plus de cases que de photos, la réutilisation est signalée à l'écran.
- Un transfert moyenne/écart-type recale la photo sur la couleur de la case, puis un mélange
  (75 % corrigé / 25 % brut) conserve le détail photographique.

Le calcul tourne dans un Web Worker (`worker.mjs`), la logique pure est dans `mosaic-core.mjs` et
se teste sous Node :

```sh
node tests/core.test.mjs
```

## Dimensionner une impression

Le nombre de cases est `colonnes × lignes`. À 300 dpi, une tuile de 48 px mesure 4 mm sur le papier :
pour que chaque photo reste lisible de près, viser 10 à 15 mm par tuile.

- 5 000 photos, grille 70 × 71 : 70 × 70 cm → tuiles de 10 mm, fichier 68 MP.
- 5 000 photos, 70 × 100 cm → tuiles de 10 × 14 mm, fichier 98 MP.
- 5 000 photos, 100 × 100 cm → tuiles de 14 mm, fichier 139 MP.

En dessous de 8 mm, les fragments deviennent du bruit.

## Limites connues

- L'appariement est colorimétrique, pas sémantique : l'outil ne sait pas choisir « des visages »
  plutôt que « des ciels ». Cette sélection reste manuelle (restreindre les photos fournies).
- Les fichiers HEIC ne sont pas décodés par tous les navigateurs ; convertir en JPEG au besoin.
- Le temps de calcul dépend surtout du décodage : ~1 000 photos en quelques secondes, 5 000 en
  quelques dizaines de secondes sur un téléphone récent.
- Pas de TIFF ni de profil ICC : sortie sRGB, à convertir chez l'imprimeur si besoin.

## Fichiers

```
index.html        interface et orchestration
mosaic-core.mjs   calcul pur (LAB, appariement, composition)
worker.mjs        décodage des photos et assemblage hors du thread principal
assets/           douze tableaux du domaine public (Wikimedia Commons)
tests/core.test.mjs  23 assertions (conversions, unicité, composition, cas limites)
```

## Licences

Code : MIT. Les images de `assets/` sont des œuvres du domaine public, reproductions Wikimedia
Commons ; leurs métadonnées d'origine sont dans `assets/manifest.json`.
