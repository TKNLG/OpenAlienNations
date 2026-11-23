// Our own player-facing texts (menus, hints, messages we added; not the original game's texts,
// which come from the player's .tdb files and so are already in the game's language) in German,
// English and French.
//
// The language follows the player's game data: DV.tdb string 81 ("off") is "Aus" in the German,
// "Off" in the English and "Désactiver" in the French release (detectLang). main.ts sets it as
// soon as DV.tdb is read; until then (the very first status line) the browser language decides.
//
// t(key, ...args): the key is the German text itself, so call sites stay readable; {0}, {1}, ...
// are replaced by the arguments. English and French come from the tables below (every key has
// both; test/i18n-client.test.ts checks that every t('...') in the sources is covered). Style:
// the wording of the original translations (English "nation", "Mentor"; French "tu", a space
// before ':', '!' and '?').

export type Lang = 'de' | 'en' | 'fr';

/** the language of the player's game data from DV.tdb string 81 ("off") */
export function detectLang(off: string | undefined): Lang {
  const v = (off ?? '').trim();
  return v === 'Aus' ? 'de' : v === 'Désactiver' ? 'fr' : 'en';
}

/** the browser's language (de / fr, else en): used until the game data is known */
export function browserLang(): Lang {
  const nav = (globalThis as { navigator?: { language?: string; languages?: readonly string[] } }).navigator;
  const tag = (nav?.languages?.[0] ?? nav?.language ?? '').toLowerCase();
  return tag.startsWith('de') ? 'de' : tag.startsWith('fr') ? 'fr' : 'en';
}

let current: Lang = browserLang();

export function setLang(l: Lang): void { current = l; }
export function lang(): Lang { return current; }

/** BCP 47 tag for dates and numbers in the current language */
export function locale(): string { return current === 'de' ? 'de-DE' : current === 'fr' ? 'fr-FR' : 'en-GB'; }

/** the text of `key` (the German text) in the current language, {n} replaced by args[n] */
export function t(key: string, ...args: (string | number)[]): string {
  const text = current === 'de' ? key : (DICT[current][key] ?? key);
  return args.length ? text.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : text;
}

/** an Error whose message is translated when shown (errText in frontend/app.ts): for code
 *  outside the client (src/engine) that must not depend on the current language */
export interface TextError extends Error { i18n?: [string, ...(string | number)[]]; }

// ---- the texts: German key -> [English, French] ------------------------------------------------

const TEXTS: Record<string, [string, string]> = {
  // generic
  'Fehler: {0}': ['Error: {0}', 'Erreur : {0}'],
  '{0}: {1}': ['{0}: {1}', '{0} : {1}'],

  // front end: main menu, campaign end (frontend/app.ts)
  'Du kannst das Browserfenster jetzt schließen.': ['You can close the browser window now.', 'Tu peux maintenant fermer la fenêtre du navigateur.'],
  'Kampagne abgeschlossen!': ['Campaign completed!', 'Campagne terminée !'],
  'kein laufendes Spiel': ['no game running', 'aucune partie en cours'],

  // settings (frontend/app.ts): labels next to the original's own
  'Erweitert': ['Enhanced', 'Avancé'],
  'Vollbild:': ['Full screen:', 'Plein écran :'],
  'Bedienleiste:': ['Side panel:', 'Barre latérale :'],
  'Auto': ['Auto', 'Auto'],
  'HD-Grafik:': ['HD graphics:', 'Graphismes HD :'],
  'Alle': ['All', 'Tous'],
  'Teilweise': ['Partly', 'Partiel'],
  'Abweichend vom Original, wirken sofort. Aus = Original.': ['Differ from the original, apply at once. Off = original.', "Diffèrent de l'original, effet immédiat. Désactiver = original."],
  'Auswahlringe:': ['Selection rings:', 'Cercles de sélection :'],
  'Flüssige Bewegung:': ['Smooth movement:', 'Mouvement fluide :'],
  'Cursor-Hinweise:': ['Cursor hints:', 'Curseurs indicatifs :'],
  'Berater-Warteschlange:': ['Mentor queue:', 'File du mentor :'],
  'Glattes Gelände:': ['Smooth terrain:', 'Terrain lissé :'],

  // load / save lists (frontend/app.ts)
  'Spielstand exportieren': ['Export save game', 'Exporter une partie'],
  'Importieren': ['Import', 'Importer'],
  'Exportieren': ['Export', 'Exporter'],

  // briefing: the decoded mission goals (frontend/app.ts, briefing.ts)
  'Missionsziele:': ['Mission goals:', 'Objectifs de la mission :'],
  'Niederlage, wenn: ': ['Defeat if: ', 'Défaite si : '],
  'Ziel: ': ['Goal: ', 'Objectif : '],
  'Amazonen': ['Amazons', 'Amazones'],
  'Pimmons': ['Pimmons', 'Pimmons'],
  'Sajiki': ['Sajkhi', 'Sajikis'],
  'keine Beziehung': ['no relation', 'aucune relation'],
  'Krieg': ['war', 'guerre'],
  'Waffenstillstand': ['armistice', 'cessez-le-feu'],
  'Frieden': ['peace', 'paix'],
  'keine': ['none', 'aucune'],
  'Typ {0}': ['type {0}', 'type {0}'],
  'in deiner ersten Stadt': ['in your first city', 'dans ta première ville'],
  'in deiner Stadt {0}': ['in your city {0}', 'dans ta ville {0}'],
  'in ihrer ersten Stadt': ['in their first city', 'dans leur première ville'],
  'in ihrer Stadt {0}': ['in their city {0}', 'dans leur ville {0}'],
  '{0} {1} auf Lager {2}': ['{0} {1} in stock {2}', '{0} {1} en réserve {2}'],
  '{0}× {1} fertiggestellt {2}': ['{0}× {1} completed {2}', '{0}× {1} achevé(s) {2}'],
  '{0} fertige Gebäude {1}': ['{0} completed buildings {1}', '{0} bâtiments achevés {1}'],
  '{0} Einwohner {1}': ['{0} residents {1}', '{0} habitants {1}'],
  'Kriminalität höchstens {0} % {1}': ['crime at most {0} % {1}', 'criminalité de {0} % au plus {1}'],
  'Zufriedenheit mindestens {0} {1}': ['satisfaction at least {0} {1}', "satisfaction d'au moins {0} {1}"],
  'keine offenen Wünsche {0}': ['no unfulfilled wishes {0}', 'aucune revendication {0}'],
  'höchstens {0} offene Wünsche {1}': ['at most {0} unfulfilled wishes {1}', 'au plus {0} revendications {1}'],
  'mindestens {0} offene Wünsche {1}': ['at least {0} unfulfilled wishes {1}', 'au moins {0} revendications {1}'],
  'Zufriedenheit höchstens {0} {1}': ['satisfaction at most {0} {1}', "satisfaction d'au plus {0} {1}"],
  'Beziehung zu den {0}: {1}': ['relation to the {0}: {1}', 'relations avec les {0} : {1}'],
  'die {0} haben kein(e) {1} mehr {2}': ['the {0} have no {1} left {2}', "les {0} n'ont plus de {1} {2}"],
  'die {0} sind ausgelöscht': ['the {0} are wiped out', 'les {0} sont anéantis'],
  '{0} {1} im Lager der Pimmons (Stadt {2})': ["{0} {1} in the Pimmons' stock (city {2})", '{0} {1} dans les réserves des Pimmons (ville {2})'],
  'kein(e) {0} mehr {1}': ['no {0} left {1}', 'plus de {0} {1}'],
  'höchstens {0}× {1} {2}': ['at most {0}× {1} {2}', 'au plus {0}× {1} {2}'],
  '{0} Gold in der Kasse': ['{0} gold in the treasury', "{0} pièces d'or dans les caisses"],
  'Ziel {0}': ['goal {0}', 'objectif {0}'],
  'Du spielst die {0}': ['You play the {0}', 'Tu joues les {0}'],
  ' · Gegenüber: {0}': [' · Opponents: {0}', ' · Adversaires : {0}'],
  'Los geht’s': ['Let’s go', 'C’est parti'],

  // multiplayer setup (frontend/multiplayer.ts)
  'Passwort': ['Password', 'Mot de passe'],
  'Passwort (optional)': ['Password (optional)', 'Mot de passe (facultatif)'],
  'Leer lassen für ein offenes Spiel': ['Leave empty for an open game', 'Laisser vide pour une partie ouverte'],
  'Falsches Passwort!': ['Wrong password!', 'Mot de passe incorrect !'],
  'Computer': ['Computer', 'Ordinateur'],
  'Leer': ['Empty', 'Vide'],
  'Keine Verbindung zum Server': ['No connection to the server', 'Pas de connexion au serveur'],
  // the lobby's error messages (src/server/lobby.ts sends them in German; translated on arrival)
  'Raum nicht verfügbar': ['Session not available', 'Session non disponible'],
  'Falsches Passwort': ['Wrong password', 'Mot de passe incorrect'],
  'Raum ist voll': ['Session is full', 'La session est complète'],
  'Unbekanntes Volk': ['Unknown nation', 'Peuple inconnu'],
  'Volk schon vergeben': ['Nation already taken', 'Peuple déjà choisi'],
  'Nicht alle Spieler haben ein Volk gewählt': ['Not all players have chosen a nation', "Tous les joueurs n'ont pas choisi de peuple"],
  'Mindestens zwei Völker müssen mitspielen': ['At least two nations must take part', 'Au moins deux peuples doivent participer'],

  // saves (saves.ts, world.ts)
  'unbekannter Fehler': ['unknown error', 'erreur inconnue'],
  'IndexedDB nicht verfügbar (privates Fenster oder blockierter Websitespeicher?)': ['IndexedDB not available (private window or blocked site storage?)', 'IndexedDB indisponible (fenêtre privée ou stockage du site bloqué ?)'],
  'IndexedDB nicht verfügbar': ['IndexedDB not available', 'IndexedDB indisponible'],
  'IndexedDB blockiert (Spiel in einem anderen Tab geöffnet?)': ['IndexedDB blocked (game open in another tab?)', 'IndexedDB bloquée (jeu ouvert dans un autre onglet ?)'],
  'Speichern fehlgeschlagen': ['Saving failed', 'Échec de la sauvegarde'],
  'Lesen fehlgeschlagen': ['Reading failed', 'Échec de la lecture'],
  'Keine gültige Spielstand-Datei': ['Not a valid save game file', 'Fichier de sauvegarde non valide'],
  'Spielstand-Version {0} wird nicht unterstützt': ['Save game version {0} is not supported', "La version {0} de la sauvegarde n'est pas prise en charge"],
  'Unbekannte Kampagne im Spielstand': ['Unknown campaign in the save game', 'Campagne inconnue dans la sauvegarde'],

  // loading (data.ts, main.ts)
  'Starte …': ['Starting …', 'Démarrage …'],
  'Lade Gelände …': ['Loading terrain …', 'Chargement du terrain …'],
  'Lade Objekte …': ['Loading objects …', 'Chargement des objets …'],
  'Lade Grafik-Index …': ['Loading graphics index …', "Chargement de l'index graphique …"],
  'Lade Mission …': ['Loading mission …', 'Chargement de la mission …'],
  'Lade Grafiken …': ['Loading graphics …', 'Chargement des graphismes …'],
  '{0}: keine Geländedaten': ['{0}: no terrain data', '{0} : aucune donnée de terrain'],
  'WebGL2 wird von diesem Browser nicht unterstützt.': ['This browser does not support WebGL2.', 'Ce navigateur ne prend pas en charge WebGL2.'],
  'Keine Spieldaten gefunden. Bitte den Alien-Nations-Ordner (mit Data/ und Bin/) im Spiele-Verzeichnis des Servers ablegen.':
    ["No game data found. Please put the Alien Nations folder (with Data/ and Bin/) into the server's game directory.",
     "Aucune donnée de jeu trouvée. Place le dossier d'Alien Nations (avec Data/ et Bin/) dans le répertoire de jeu du serveur."],

  // in-game hints and status lines (overlay.ts, main.ts)
  'Linksklick: Bauplatz wählen · Rechtsklick/Esc: abbrechen': ['Left click: choose site · Right click/Esc: cancel', "Clic gauche : choisir l'emplacement · Clic droit/Échap : annuler"],
  'Linksklick: Wegpunkt (Strg: weitere) · Rechtsklick: fertig': ['Left click: waypoint (Ctrl: more) · Right click: done', 'Clic gauche : point de passage (Ctrl : autres) · Clic droit : terminé'],
  '{0} — du spielst die {1} · {2}×{2} · {3} eigene Einheiten': ['{0} — you play the {1} · {2}×{2} · {3} own units', '{0} — tu joues les {1} · {2}×{2} · {3} unités à toi'],
  'Achtung: Spielstände weichen ab (Tick {0})': ['Warning: the game states differ (tick {0})', 'Attention : les états de jeu divergent (tick {0})'],
  'Spielstand „{0}“ geladen': ['Save game “{0}” loaded', 'Partie « {0} » chargée'],
  'Mehrspieler: {0} Spieler, du bist Spieler {1} ({2})': ['Multiplayer: {0} players, you are player {1} ({2})', 'Multijoueurs : {0} joueurs, tu es le joueur {1} ({2})'],

  // developer bar (index.html, main.ts with ?dev)
  'Kampagne': ['Campaign', 'Campagne'],
  'Mission': ['Mission', 'Mission'],
  'Größe der Bedienleiste': ['Side panel size', 'Taille de la barre latérale'],
  'UI: automatisch': ['UI: automatic', 'Interface : auto'],
  'Musik an/aus': ['Music on/off', 'Musique oui/non'],
  '♪ an': ['♪ on', '♪ oui'],
  '♪ aus': ['♪ off', '♪ non'],
  'Spielstände': ['Save games', 'Sauvegardes'],
  'Mehrspieler': ['Multiplayer', 'Multijoueurs'],
  'Name des Spielstands': ['Name of the save game', 'Nom de la sauvegarde'],
  'Speichern': ['Save', 'Sauvegarder'],
  'Spielstand-Datei importieren: ': ['Import save game file: ', 'Importer un fichier de sauvegarde : '],
  'Name ': ['Name ', 'Nom '],
  'Spieler': ['Player', 'Joueur'],
  'Spiel mit dieser Mission eröffnen': ['Open a game with this mission', 'Ouvrir une partie avec cette mission'],
  'Aktualisieren': ['Refresh', 'Actualiser'],
  'Links: auswählen (ziehen = Rahmen) · Rechts: bewegen · Mitteltaste ziehen / Pfeiltasten / WASD: scrollen · Mausrad: zoomen':
    ['Left: select (drag = box) · Right: move · Middle button drag / arrow keys / WASD: scroll · Mouse wheel: zoom',
     'Gauche : sélectionner (glisser = cadre) · Droite : déplacer · Bouton du milieu / flèches / WASD : défiler · Molette : zoom'],
  'Texteingabe': ['Text input', 'Saisie de texte'],
  'Noch keine Spielstände.': ['No save games yet.', 'Aucune partie sauvegardée.'],
  'Laden': ['Load', 'Charger'],
  'Als Datei herunterladen': ['Download as a file', 'Télécharger comme fichier'],
  'Löschen': ['Delete', 'Supprimer'],
  'Speichern im Mehrspielermodus kommt später.': ['Saving in multi-player mode comes later.', 'La sauvegarde en partie multijoueurs viendra plus tard.'],
  'Spielstand {0}': ['Save game {0}', 'Partie {0}'],
  'Gespeichert: {0}': ['Saved: {0}', 'Sauvegardé : {0}'],
  'Speichern fehlgeschlagen: {0}': ['Saving failed: {0}', 'Échec de la sauvegarde : {0}'],
  'Spielstand importiert': ['Save game imported', 'Partie importée'],
  'Raum „{0}“ – {1}/{2} Spieler': ['Session “{0}” – {1}/{2} players', 'Session « {0} » – {1}/{2} joueurs'],
  ' (du)': [' (you)', ' (toi)'],
  'Spiel starten': ['Start game', 'Démarrer le jeu'],
  'Verlassen': ['Leave', 'Quitter'],
  'Keine offenen Spiele.': ['No open games.', 'Aucune partie ouverte.'],
  '{0}s Spiel': ['{0}’s game', 'Partie de {0}'],
  // campaign names of the developer bar (data.ts, frontend/freeplay.ts labels)
  'Amazonen (Addon)': ['Amazons (add-on)', 'Amazones (add-on)'],
  'Pimmons (Addon)': ['Pimmons (add-on)', 'Pimmons (add-on)'],
  'Sajiki (Addon)': ['Sajkhi (add-on)', 'Sajikis (add-on)'],
  'Tutorials': ['Tutorials', 'Initiation'],
  'Endlosspiel': ['Never-ending game', 'Illimité'],
  'Endlosspiel (Addon)': ['Never-ending game (add-on)', 'Illimité (add-on)'],
};

/** the English and French tables (exported for the tests) */
export const DICT: Record<'en' | 'fr', Record<string, string>> = { en: {}, fr: {} };
for (const [k, [en, fr]] of Object.entries(TEXTS)) { DICT.en[k] = en; DICT.fr[k] = fr; }
