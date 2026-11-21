# Buzzer — Blind test XXL de BBV

Un buzzer sur smartphone pour des centaines d'équipes, avec un écran projeté qui affiche les temps de réaction et le classement.

- **Page joueurs** (`/`) : règles, nom d'équipe, joueurs, gros buzzer rouge, temps de réaction, classement général avec 🥇🥈🥉.
- **Écran projeté + régie** (`/ecran`) : QR code d'inscription, temps de réaction en direct, validation des réponses, classement général avec 🥇🥈🥉.
- **Serveur** (`server.js`) : fait le lien entre tout le monde en temps réel.

Testé avec 300 équipes simulées connectées en même temps.

---

## 1. Essayer sur ton ordi (10 minutes)

1. Installe **Node.js** (version « LTS ») depuis nodejs.org.
2. Télécharge le code (bouton vert **Code → Download ZIP** sur GitHub), dézippe-le, ouvre un terminal dans le dossier.
3. Tape :
   ```
   npm install
   npm start
   ```
4. Le terminal affiche l'adresse de la page joueurs, celle de l'écran et le **code régie**.
5. Ouvre `http://localhost:3000/ecran` sur ton ordi, entre le code régie.
6. Avec ton téléphone connecté **au même Wi‑Fi**, scanne le QR code affiché.

Pour choisir ton propre code régie au lieu d'un code aléatoire :
- Mac / Linux : `ADMIN_KEY=BBV2026 npm start`
- Windows (PowerShell) : `$env:ADMIN_KEY="BBV2026"; npm start`

### Répéter avec 300 fausses équipes
Serveur lancé, dans un deuxième terminal :
```
npm run simulation -- http://localhost:3000 300
```
300 équipes de test s'inscrivent puis buzzent toutes seules pendant chaque extrait, chacune au bout d'un temps différent. Après la répétition : **Réglages → Tout effacer**.

---

## 2. Mettre en ligne pour la soirée

Pour la vraie soirée, le serveur doit être **sur Internet** : les téléphones en 4G ne peuvent pas joindre ton ordi, et le Wi‑Fi invité d'un lieu bloque souvent les échanges entre appareils.

### Avec Render, en un clic

[![Mettre en ligne sur Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/yoyo-fait-son-show/buzzer-blind-test)

1. Clique sur le bouton ci-dessus et connecte-toi à Render **avec ton compte GitHub**.
2. Render te demande la valeur de `ADMIN_KEY` : c'est ton **code régie**, choisis-le (ex. `BBV2026`) et note-le.
3. Clique sur **Deploy Blueprint** (ou **Apply**) et attends 2 à 3 minutes que le statut passe à « Live ».
4. Render affiche alors l'adresse du service, du type `https://buzzer-blind-test.onrender.com` (le nom peut varier).
   - Joueurs : l'adresse telle quelle
   - Écran : l'adresse suivie de `/ecran`

Pour changer le code régie plus tard : Render → ton service → **Environment** → `ADMIN_KEY`.

### À savoir sur l'offre gratuite de Render
- Le service **s'endort après 15 minutes sans trafic** et met environ une minute à se réveiller. Ouvre l'écran **10 minutes avant** l'ouverture des portes.
- Render peut **redémarrer un service gratuit à tout moment**, et ses fichiers sont alors effacés. Le buzzer est prévu pour ça : l'écran de régie garde une copie de la partie et la renvoie automatiquement au serveur s'il redémarre à vide. Les téléphones patientent quelques secondes puis retrouvent leur équipe et leurs points. **Garde l'onglet `/ecran` ouvert toute la soirée.**
- Pour une soirée à 300 équipes, passer l'instance en offre payante le temps de l'événement est plus sûr (plus de puissance, pas de mise en veille). Tu peux redescendre en gratuit après.

Toute autre plateforme qui fait tourner Node.js et accepte les WebSockets fonctionne aussi (Railway, Fly.io, un petit serveur VPS…).

---

## 3. Déroulé de la soirée

**Avant**
- Ordi relié au vidéoprojecteur : ouvre `/ecran`, entre le code régie, appuie sur **F** (plein écran).
- La vue **Inscription** affiche le QR code et le compteur d'équipes.
- Teste le réseau sur place avec 2-3 téléphones (4G et Wi‑Fi).
- **Régie sur téléphone** : ouvre aussi `/ecran` sur ton téléphone (même code régie), en portrait ou en paysage. Tout ce que tu fais dessus (lancer/stopper, ✅ ❌, jokers, réglages) s'applique à l'écran projeté. Touche le titre « Jokers à traiter » pour replier la boîte et voir les verdicts dessous.

**Pour chaque extrait**

| Touche | Ce qui se passe |
|---|---|
| **Espace** | Lance l'extrait : flash rouge, **les buzzers sont ouverts tout de suite** et le chrono démarre. Lance ta musique dans le même geste. |
| **Espace** | Stoppe l'extrait : les buzzers se ferment. L'équipe la plus rapide est encadrée « À vous ! ». |
| **O** | Bonne réponse : l'équipe marque ses points. |
| **N** | Mauvaise réponse : la main passe à l'équipe suivante. |
| **Retour** | Annule le dernier verdict. |
| **C** | Affiche le classement général. **E** revient à l'extrait, **I** au QR code. |
| **H** | Masque / affiche la barre de régie. |

Tu peux aussi cliquer sur ✅ / ❌ à côté de n'importe quelle équipe.

> ⚠️ **Le chrono démarre quand tu appuies sur Espace**, pas quand la musique démarre vraiment. Lance la musique et appuie sur Espace dans le même geste (musique sur un autre appareil ou une table de mixage, Espace avec l'autre main).

**Pas de faux départ** : les équipes peuvent buzzer pendant la musique, personne n'est bloqué. Le temps affiché est le temps écoulé depuis le lancement de l'extrait, donc la première équipe à reconnaître le morceau est première. Un seul buzz par équipe et par extrait.

**Stopper l'extrait** quand tu veux : quand une équipe a buzzé et que tu veux couper, ou si personne ne trouve. Les buzzers se ferment, tu donnes les verdicts, puis Espace pour l'extrait suivant.

**Annuler l'extrait** (barre de régie) : supprime l'extrait en cours si tu as lancé ou arrêté trop tôt par erreur.

---

## 4. Les points

Seules les bonnes réponses rapportent des points, selon la place au buzz :

| Place au buzz | 1er | 2e | 3e | 4e | 5e | 6e | 7e | 8e et + |
|---|---|---|---|---|---|---|---|---|
| Points | 10 | 8 | 6 | 5 | 4 | 3 | 2 | 1 |

Modifiable dans **Réglages → Points selon la rapidité**. Égalité au classement : le plus de bonnes réponses, puis le meilleur temps.

---

## 5. Le joker 🃏

**Le mot de passe** : Réglages → Jokers → « Mot de passe joker ». Quand il est rempli, une case facultative apparaît à l'inscription. Bon mot de passe = un joker pour l'équipe ; mauvais = tant pis, l'équipe est inscrite sans joker. Majuscules, accents et espaces ne comptent pas. Tu peux le changer quand tu veux : les jokers déjà donnés restent. Laisse vide pour cacher la case.

**Utilisation** : seulement **entre deux extraits** (buzzers fermés). L'équipe appuie sur « Utiliser mon joker » puis choisit :
- **+1 point** : une notification arrive sur la régie, le point compte quand tu cliques **Valider** (ou touche **J**). « Valider tous les +1 » traite tout d'un coup.
- **Donne ton défi** : le joker est consommé tout de suite, l'équipe te dit son défi à voix haute. **OK** ferme la notification.

**Annuler** (sur la notification ou dans l'historique) rend le joker à l'équipe et retire le +1 s'il avait été validé.

**Dans Réglages → Jokers** : décocher « Jokers utilisables » bloque les jokers (ex. avant le dernier extrait), « Donner un joker à toutes les équipes », historique de qui a utilisé son joker. Dans la liste des équipes : **+🃏 / −🃏** pour donner ou retirer un joker à une équipe, et la case « Seulement les équipes avec un joker ».

Les notifications de joker s'affichent au-dessus de la barre de régie, donc **sur l'écran projeté** (touche **H** pour tout masquer). Attention aussi au mot de passe si tu ouvres les Réglages pendant que l'écran est projeté : il est masqué par défaut, le bouton 👁 l'affiche.

Le classement exporté (Excel) indique le bonus joker, les défis et les jokers restants de chaque équipe.

---

## 6. Précision des temps

Chaque téléphone synchronise son horloge avec le serveur et note l'heure exacte de son appui. Une connexion lente ne fait donc pas perdre de temps : c'est le doigt qui compte, pas le réseau.

En test avec une latence 4G irrégulière simulée, l'écart de mesure était d'environ 12 ms en général et de moins de 40 ms dans 95 % des cas. Deux équipes séparées de moins de 0,04 s sont donc à égalité en pratique : si l'enjeu est gros, fais-les répondre toutes les deux.

---

## 7. Pendant et après

- **Nom d'équipe déplacé** : Réglages → Équipes → Renommer ou Retirer.
- **Fermer les inscriptions** : Réglages → décocher « Inscriptions ouvertes ».
- **Résultats** : Réglages → Télécharger le classement (s'ouvre dans Excel).
- **Nouvelle soirée** : Réglages → Tout effacer.
- **Un téléphone se verrouille ou recharge la page** : il retrouve son équipe tout seul.
- **Un joueur s'est inscrit sur le mauvais téléphone** : onglet Classement → « Se déconnecter », puis réinscription.

## 8. Dépannage

| Problème | Solution |
|---|---|
| L'écran demande le code régie en boucle | Vérifie `ADMIN_KEY` dans les réglages Render (majuscules/minuscules ignorées). |
| Le QR code affiche une adresse locale | Ouvre l'écran avec l'adresse en ligne (onrender.com), pas `localhost`. |
| « Connexion au serveur perdue » sur l'écran | Le serveur redémarre ou se réveille : patiente, l'écran se reconnecte et restaure la partie. |
| Rien ne se passe sur les téléphones | Vérifie la connexion internet du lieu, puis recharge la page. |

---

Polices : Bungee et Bricolage Grotesque, licence SIL Open Font License 1.1, incluses dans `public/fonts`.
