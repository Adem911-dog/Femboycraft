# FemboyCraft

Launcher Windows en français, construit avec Electron. Il propose des profils hors ligne, l’authentification Microsoft, toutes les versions officielles stables de Minecraft Java (Vanilla ou Fabric), la recherche de contenus Modrinth et l’envoi d’un skin PNG au profil Minecraft.

L’interface propose un thème pastel et un thème rose & noir mémorisé entre les démarrages, avec quelques easter eggs cachés.

## Démarrer

1. Installe Node.js 22.12 ou plus récent.
2. Dans ce dossier, lance `npm install`.
3. Lance `npm start`.

Le launcher télécharge les fichiers du jeu et un runtime Java adapté au premier démarrage d’une instance.

## Créer l’installateur Windows

Avec Node.js 22.12 ou plus récent, lance `npm run dist:win`. L’installateur NSIS est créé dans `dist/Femboy-Craft-Setup-1.0.0.exe`.

## Connexion Microsoft

Dans le launcher, clique sur **Microsoft** en bas à gauche. Une fenêtre de connexion Microsoft s’ouvre; saisis ton e-mail et ton mot de passe **uniquement sur la page officielle Microsoft**, puis autorise la connexion. Le launcher ne demande ni ne stocke ton mot de passe ou un identifiant d’application personnel.

Les jetons Microsoft/Minecraft sont chiffrés avec le stockage sécurisé de Windows. Tu peux aussi choisir **Hors ligne** ou **Compte Microsoft** dans « Mode de jeu » avant de lancer Minecraft. Le mode hors ligne requiert un profil local et ne donne pas accès aux serveurs qui demandent un compte authentifié.

## Clients Fabric

Sur Minecraft 1.21.11, le launcher installe OneClient et son pack complet depuis Modrinth avec Fabric Loader 0.20.1. L’ancien mod de menu Femboy-Craft n’est plus installé et est supprimé des instances Fabric concernées au prochain lancement. Les autres versions Fabric reçoivent uniquement des mods d’optimisation compatibles (Sodium, Lithium, Entity Culling, Zoomify et 3D Skin Layers). Les fichiers OneClient sont vérifiés par SHA-1 et un manifeste local évite les téléchargements répétés.

## Fonctionnalités et limites

- Le sélecteur charge toutes les versions stables publiées depuis le manifeste officiel de Minecraft. Les snapshots ne sont pas incluses. La compatibilité des mods Fabric dépend de chaque version.
- Les profils hors ligne sont locaux à cet ordinateur. Une instance doit avoir été installée une première fois pour jouer sans connexion; le launcher conserve les métadonnées nécessaires. Le mode hors ligne ne donne pas accès aux serveurs qui exigent un compte authentifié.
- Fabric est le chargeur par défaut pour les mods. Les mods Modrinth sont filtrés selon le jeu et Fabric; il faut choisir Fabric pour les lancer.
- OneClient est installé automatiquement sur Minecraft 1.21.11 avec Fabric. Les shaders du pack sont installés mais ne sont pas activés automatiquement; Zoomify se configure dans **Options > Contrôles**.
- Dans « Découvrir », le pack PvP léger installe uniquement Toggle Sprint quand une version compatible est disponible.
- La mémoire JVM s’adapte à la RAM détectée (environ 40 %, plafonnée à 6 Go, avec un tas initial de 1 Go). Sur un PC à 8 Go, ferme les autres applications si le jeu manque encore de mémoire; vérifie aussi que le fichier d’échange Windows est activé.
- La liste « Amis » est un carnet local de pseudos. Elle ne découvre pas les autres joueurs, ne vérifie pas leur identité et n’est pas synchronisée entre ordinateurs.
- Les shaders nécessitent un chargeur compatible (par exemple Iris), à installer comme mod. Les packs de ressources sont placés dans le dossier de l’instance; les datapacks téléchargés doivent être ajoutés au dossier d’un monde.
- Les skins sont stockés localement en PNG. « Appliquer au compte » les envoie au service officiel Minecraft et nécessite un compte Microsoft possédant Minecraft Java.

Le launcher n’est ni affilié à Mojang ni à Microsoft. Respecte les conditions d’utilisation et les licences des contenus téléchargés.
