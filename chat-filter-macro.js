/**
 * Chat-Filter als Icon in der Chat-Leiste
 * Foundry VTT v14 / PF2e
 *
 * Features:
 * - Filtert Chatnachrichten nach einem oder mehreren Spielern
 * - Zeigt auch Nachrichten, die einen Spieler betreffen
 *   (Sprecher, Ziel, Schaden, Flüstern) - abschaltbar im Menü
 * - Button sitzt in der Chat-Steuerleiste und übernimmt
 *   das Aussehen der benachbarten Buttons
 * - Zeigt ALLE Spieler-Accounts, auch offline
 * - GM-Accounts werden ausgeblendet
 * - Online-/Offline-Markierung
 * - Filter bleibt für neue Chatnachrichten aktiv
 * - Keine ChatMessages werden verändert oder gelöscht
 */

const FILTER_BUTTON_ID = "pf2e-chat-filter-button";
const FILTER_MENU_ID = "pf2e-chat-filter-menu";
const OBSERVER_KEY = "__pf2eChatFilterObserver";
const HANDLER_KEY = "__pf2eChatFilterOutsideClick";
const HOOK_KEY = "__pf2eChatFilterHooks";

// ------------------------------------------------------------
// Alte Instanz entfernen
// ------------------------------------------------------------

document.getElementById(FILTER_BUTTON_ID)?.remove();
document.getElementById(FILTER_MENU_ID)?.remove();

if (window[OBSERVER_KEY]) {
  window[OBSERVER_KEY].disconnect();
  delete window[OBSERVER_KEY];
}

if (window[HANDLER_KEY]) {
  document.removeEventListener("pointerdown", window[HANDLER_KEY], true);
  delete window[HANDLER_KEY];
}

// Alte Hooks abmelden, sonst hängen sie sich bei jedem Start neu ein
if (window[HOOK_KEY]) {
  for (const [hookName, hookId] of window[HOOK_KEY]) {
    Hooks.off(hookName, hookId);
  }

  delete window[HOOK_KEY];
}

// ------------------------------------------------------------
// Chat finden
// ------------------------------------------------------------

function getChatRoot() {
  return ui.chat?.element ?? null;
}

if (!getChatRoot()) {
  ui.notifications.error("Chat konnte nicht gefunden werden.");
  return;
}

// ------------------------------------------------------------
// Ankerpunkt für den Button: die Steuerleiste unter dem Chat
// ------------------------------------------------------------

function findAnchor() {
  const root = getChatRoot();

  if (!root) return null;

  return (
    root.querySelector("#chat-controls .control-buttons") ??
    root.querySelector(".chat-controls .control-buttons") ??
    root.querySelector("#chat-controls") ??
    root.querySelector(".chat-controls") ??
    root.querySelector("#roll-privacy")?.parentElement ??
    null
  );
}

if (!findAnchor()) {
  ui.notifications.error(
    "Chat-Steuerleiste konnte nicht gefunden werden."
  );

  console.warn("[Chat Filter] Chat-Root:", getChatRoot());

  return;
}

// ------------------------------------------------------------
// Hilfsfunktion: Autor einer ChatMessage
// ------------------------------------------------------------

function getMessageUserId(message) {
  return (
    message?.author?.id ??
    message?.user?.id ??
    message?.user ??
    null
  );
}

// ------------------------------------------------------------
// ALLE Spieler holen
// ------------------------------------------------------------

const users = [...game.users]
  .filter(user => !user.isGM)
  .sort((a, b) => {
    // Online zuerst
    if (a.active !== b.active) {
      return Number(b.active) - Number(a.active);
    }

    // Danach alphabetisch
    return a.name.localeCompare(b.name);
  });

console.log(
  "[Chat Filter] Verfügbare Spieler:",
  users.map(user => ({
    name: user.name,
    id: user.id,
    active: user.active
  }))
);

// ------------------------------------------------------------
// Aktueller Filter
//
// Leere Auswahl = kein Filter, alles sichtbar.
// ------------------------------------------------------------

const selectedUserIds = new Set();

// true  = alles zeigen, was den Spieler betrifft
// false = nur Nachrichten, die er selbst geschrieben/gewürfelt hat
let includeRelated = true;

const identityCache = new Map();   // userId -> Set<string>
const relevanceCache = new Map();  // "messageId:userId" -> boolean

function selectedNames() {
  return [...selectedUserIds]
    .map(id => game.users.get(id)?.name ?? id)
    .sort((a, b) => a.localeCompare(b));
}

// ------------------------------------------------------------
// Identität eines Spielers sammeln
//
// Ein Spieler taucht in Nachrichten nicht nur als User auf,
// sondern über seine Actors und deren Tokens.
// ------------------------------------------------------------

function getUserIdentifiers(userId) {
  if (identityCache.has(userId)) {
    return identityCache.get(userId);
  }

  const ids = new Set();
  const user = game.users.get(userId);

  if (!user) {
    identityCache.set(userId, ids);
    return ids;
  }

  ids.add(user.id);

  // Alle Actors, die dem Spieler gehören (Charakter, Tiergefährte,
  // Familiar, Zweitcharakter ...)
  const actors = game.actors.filter(actor =>
    actor.testUserPermission(user, "OWNER")
  );

  if (user.character && !actors.includes(user.character)) {
    actors.push(user.character);
  }

  const actorIds = new Set();

  for (const actor of actors) {
    actorIds.add(actor.id);

    ids.add(actor.id);
    ids.add(actor.uuid);
  }

  // Tokens dieser Actors auf allen Szenen
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (!actorIds.has(token.actorId)) continue;

      ids.add(token.id);
      ids.add(token.uuid);
    }
  }

  identityCache.set(userId, ids);

  console.log(`[Chat Filter] Kennungen für ${user.name}:`, [...ids]);

  return ids;
}

// ------------------------------------------------------------
// Treffer in einem String suchen
//
// UUIDs sehen aus wie "Scene.abc.Token.def.Actor.ghi",
// deshalb wird an den Punkten zerlegt statt stumpf verglichen.
// ------------------------------------------------------------

function stringMatches(value, ids) {
  if (typeof value !== "string") return false;

  if (ids.has(value)) return true;

  if (!value.includes(".")) return false;

  return value.split(".").some(part => ids.has(part));
}

// ------------------------------------------------------------
// Flags rekursiv durchsuchen
//
// PF2e legt Ziel, Herkunft und angewendeten Schaden je nach
// Nachrichtentyp an unterschiedlichen Stellen ab.
// ------------------------------------------------------------

function flagsMatch(value, ids, depth = 0) {
  if (value == null || depth > 6) return false;

  if (typeof value === "string") {
    return stringMatches(value, ids);
  }

  if (Array.isArray(value)) {
    return value.some(entry => flagsMatch(entry, ids, depth + 1));
  }

  if (typeof value === "object") {
    return Object.values(value).some(entry =>
      flagsMatch(entry, ids, depth + 1)
    );
  }

  return false;
}

// ------------------------------------------------------------
// Betrifft die Nachricht den Spieler?
// ------------------------------------------------------------

function messageConcernsUser(message, userId) {
  // Autor - das war der ursprüngliche Filter
  if (getMessageUserId(message) === userId) return true;

  if (!includeRelated) return false;

  const cacheKey = `${message.id}:${userId}`;

  if (relevanceCache.has(cacheKey)) {
    return relevanceCache.get(cacheKey);
  }

  const ids = getUserIdentifiers(userId);

  let result = false;

  // Geflüstertes an den Spieler
  const whisper = message.whisper ?? [];

  if (Array.isArray(whisper) && whisper.includes(userId)) {
    result = true;
  }

  // Sprecher: deckt "nimmt X Schaden", Rettungswürfe des
  // Charakters, Fähigkeiten des Tiergefährten usw. ab
  if (!result) {
    const speaker = message.speaker ?? {};

    if (ids.has(speaker.actor) || ids.has(speaker.token)) {
      result = true;
    }
  }

  // Ziel, Herkunft, angewendeter Schaden - alles in den Flags
  if (!result && flagsMatch(message.flags, ids)) {
    result = true;
  }

  relevanceCache.set(cacheKey, result);

  return result;
}

// ------------------------------------------------------------
// Filter anwenden
// ------------------------------------------------------------

function applyFilter() {
  const root = getChatRoot();

  if (!root) return;

  const messageElements = root.querySelectorAll(".chat-message");
  const active = [...selectedUserIds];

  let visible = 0;
  let hidden = 0;

  for (const element of messageElements) {
    const messageId = element.dataset.messageId;
    const message = game.messages.get(messageId);

    if (!message) {
      element.hidden = false;
      element.style.display = "";
      continue;
    }

    // Mehrfachauswahl: eine Übereinstimmung reicht,
    // die Prüfung bricht beim ersten Treffer ab.
    const show =
      !active.length ||
      active.some(userId => messageConcernsUser(message, userId));

    // hidden allein reicht nicht: Foundrys CSS setzt display
    // auf .chat-message und überstimmt das Attribut.
    element.hidden = !show;
    element.style.display = show ? "" : "none";

    if (show) {
      visible++;
    } else {
      hidden++;
    }
  }

  console.log(
    `[Chat Filter] Auswahl=${selectedNames().join(", ") || "ALLE"}, ` +
    `Bezug=${includeRelated ? "an" : "aus"}, ` +
    `sichtbar=${visible}, ausgeblendet=${hidden}`
  );

  updateButtonState();
}

// ------------------------------------------------------------
// Filterbutton erstellen
// ------------------------------------------------------------

const button = document.createElement("button");

button.id = FILTER_BUTTON_ID;
button.type = "button";

// ------------------------------------------------------------
// Aussehen vom Nachbarn übernehmen
//
// Foundry stylt seine Leisten-Buttons über Klassen. Statt eigene
// Maße zu setzen (die dann daneben stehen), kopieren wir die
// Klassen eines Nachbarn und tauschen nur das Icon aus.
// ------------------------------------------------------------

function adoptSiblingStyle(container) {
  const sibling = [...container.querySelectorAll("button")].find(
    element => element !== button
  );

  button.removeAttribute("style");
  button.className = "";

  if (sibling) {
    const classes = [...sibling.classList].filter(
      name => !name.startsWith("fa-") && name !== "active"
    );

    if (classes.length) button.classList.add(...classes);

    // Manche Buttons tragen das Icon selbst als Klasse,
    // andere haben ein <i> darin.
    const iconAsClass = [...sibling.classList].some(name =>
      name.startsWith("fa-")
    );

    if (iconAsClass) {
      button.classList.add("fa-solid", "fa-filter");
      button.innerHTML = "";
    } else {
      button.innerHTML = `<i class="fa-solid fa-filter"></i>`;
    }
  } else {
    button.classList.add("ui-control", "icon", "fa-solid", "fa-filter");
    button.innerHTML = "";
  }

  button.style.flex = "0 0 auto";
  button.style.setProperty("pointer-events", "auto", "important");
}

// ------------------------------------------------------------
// Button einhängen
//
// Wird auch nach einem Neu-Rendern des Chats wieder aufgerufen,
// sonst wäre der Button danach weg.
// ------------------------------------------------------------

function mountButton() {
  const anchor = findAnchor();

  if (!anchor) return false;

  if (button.parentElement !== anchor) {
    adoptSiblingStyle(anchor);
    anchor.prepend(button);
  }

  attachObserver();
  updateButtonState();

  if (selectedUserIds.size) applyFilter();

  return true;
}

// ------------------------------------------------------------
// Observer an das aktuelle Chat-Log hängen
// ------------------------------------------------------------

function attachObserver() {
  const root = getChatRoot();
  const chatLog = root?.querySelector("ol.chat-log");

  if (!chatLog) return;

  if (window[OBSERVER_KEY]) {
    window[OBSERVER_KEY].disconnect();
  }

  const observer = new MutationObserver(() => {
    if (!selectedUserIds.size) return;

    applyFilter();
  });

  observer.observe(chatLog, {
    childList: true,
    subtree: false
  });

  window[OBSERVER_KEY] = observer;
}

// ------------------------------------------------------------
// Button-Zustand aktualisieren
// ------------------------------------------------------------

function updateButtonState() {
  const active = selectedUserIds.size > 0;

  button.classList.toggle("active", active);

  if (active) {
    const names = selectedNames();
    const suffix = includeRelated ? " (inkl. Bezug)" : " (nur eigene)";

    button.title = `Chat-Filter: ${names.join(", ")}${suffix}`;

    button.style.boxShadow = "inset 0 0 0 2px var(--color-warm-1)";
  } else {
    button.title = "Chat nach Spieler filtern";

    button.style.boxShadow = "";
  }
}

// ------------------------------------------------------------
// Menü erzeugen
// ------------------------------------------------------------

function createMenu() {
  const existing = document.getElementById(FILTER_MENU_ID);

  if (existing) {
    existing.remove();
    return;
  }

  const menu = document.createElement("div");

  menu.id = FILTER_MENU_ID;

  menu.style.cssText = `
    position: fixed;

    box-sizing: border-box;

    width: 260px;
    max-height: 70vh;

    overflow-y: auto;

    padding: 6px;

    background: var(--color-cool-5, #222);

    border: 1px solid var(--color-border-light-2);

    border-radius: 5px;

    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);

    z-index: 100000;

    pointer-events: auto;
  `;

  menu.style.setProperty("pointer-events", "auto", "important");

  // --------------------------------------------------------
  // Menüeintrag erzeugen
  // --------------------------------------------------------

  function addEntry({
    label,
    online = null,
    selected = false,
    tooltip = "",
    onClick
  }) {
    const entry = document.createElement("button");

    entry.type = "button";

    if (tooltip) entry.title = tooltip;

    let statusIcon = "";

    if (online === true) {
      statusIcon = `<i
        class="fa-solid fa-circle"
        title="Online"
        style="font-size: 8px;"
      ></i>`;
    }

    if (online === false) {
      statusIcon = `<i
        class="fa-regular fa-circle"
        title="Offline"
        style="font-size: 8px;"
      ></i>`;
    }

    // Kein Leerraum zwischen den Spans: sonst erzeugen die
    // Zeilenumbrüche im Template zusätzliche Textknoten.
    entry.innerHTML =
      `<span style="display:flex;align-items:center;justify-content:center;">` +
      statusIcon +
      `</span>` +
      `<span style="min-width:0;overflow-wrap:anywhere;">` +
      foundry.utils.escapeHTML(label) +
      `</span>` +
      `<span style="display:flex;align-items:center;justify-content:center;">` +
      (selected ? `<i class="fa-solid fa-check"></i>` : "") +
      `</span>`;

    entry.style.cssText = `
      box-sizing: border-box;

      width: 100%;
      min-height: 32px;

      display: grid;

      grid-template-columns: 20px 1fr 20px;

      align-items: center;
      align-content: center;

      gap: 6px;

      text-align: left;

      line-height: 1.25;

      padding: 5px 8px;
      margin: 2px 0;

      cursor: pointer;
    `;

    entry.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      onClick();
    });

    menu.append(entry);
  }

  function addSeparator() {
    const separator = document.createElement("hr");

    separator.style.cssText = `
      margin: 4px 0;
      opacity: 0.4;
    `;

    menu.append(separator);
  }

  // --------------------------------------------------------
  // Menü aufbauen
  //
  // Bei Mehrfachauswahl bleibt das Menü offen, deshalb wird
  // der Inhalt nach jedem Klick neu gezeichnet.
  // --------------------------------------------------------

  function render() {
    menu.replaceChildren();

    const header = document.createElement("div");

    header.textContent = selectedUserIds.size
      ? `Gefiltert: ${selectedNames().join(", ")}`
      : "Chat nach Spieler filtern";

    header.style.cssText = `
      font-weight: bold;

      padding: 4px 8px 8px;

      border-bottom: 1px solid var(--color-border-light-2);

      margin-bottom: 4px;

      overflow-wrap: anywhere;
    `;

    menu.append(header);

    // Alle Spieler = Filter aus
    addEntry({
      label: "Alle Spieler",
      selected: selectedUserIds.size === 0,
      tooltip: "Filter zurücksetzen",
      onClick: () => {
        selectedUserIds.clear();

        applyFilter();
        render();
      }
    });

    addSeparator();

    for (const user of users) {
      addEntry({
        label: user.name,
        online: user.active,
        selected: selectedUserIds.has(user.id),
        tooltip: "Mehrfachauswahl möglich",
        onClick: () => {
          if (selectedUserIds.has(user.id)) {
            selectedUserIds.delete(user.id);
          } else {
            selectedUserIds.add(user.id);
          }

          applyFilter();
          render();
        }
      });
    }

    addSeparator();

    addEntry({
      label: "Bezug einbeziehen",
      selected: includeRelated,
      tooltip:
        "Auch Nachrichten anzeigen, die den Spieler betreffen: " +
        "als Ziel, Schaden, Geflüstertes",
      onClick: () => {
        includeRelated = !includeRelated;

        relevanceCache.clear();

        applyFilter();
        render();
      }
    });
  }

  render();

  document.body.append(menu);

  // --------------------------------------------------------
  // Menü am Button ausrichten
  //
  // Der Button sitzt unten im Chat, also wird nach oben und
  // nach links geöffnet, wenn dort mehr Platz ist.
  // --------------------------------------------------------

  const rect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();

  let left = rect.right + 6;
  let top = rect.top;

  if (left + menuRect.width > window.innerWidth) {
    left = rect.left - menuRect.width - 6;
  }

  if (top + menuRect.height > window.innerHeight) {
    top = rect.bottom - menuRect.height;
  }

  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

// ------------------------------------------------------------
// Button-Klick
// ------------------------------------------------------------

button.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();

  createMenu();
});

// ------------------------------------------------------------
// Klick außerhalb -> Menü schließen
// ------------------------------------------------------------

const outsideClickHandler = event => {
  const menu = document.getElementById(FILTER_MENU_ID);

  if (!menu) return;

  if (
    menu.contains(event.target) ||
    button.contains(event.target)
  ) {
    return;
  }

  menu.remove();
};

document.addEventListener("pointerdown", outsideClickHandler, true);

window[HANDLER_KEY] = outsideClickHandler;

// ------------------------------------------------------------
// Einhängen - jetzt und nach jedem Neu-Rendern
// ------------------------------------------------------------

mountButton();

const hookIds = [];

for (const hookName of [
  "renderChatLog",
  "renderChatInput",
  "renderSidebar",
  "changeSidebarTab"
]) {
  hookIds.push([
    hookName,
    Hooks.on(hookName, () => window.setTimeout(mountButton, 0))
  ]);
}

window[HOOK_KEY] = hookIds;

// ------------------------------------------------------------
// Fertig
// ------------------------------------------------------------

console.log("[Chat Filter] Filterbutton eingefügt.", {
  anchor: findAnchor(),
  users
});

ui.notifications.info(
  `Chat-Filter bereit: ${users.length} Spieler verfügbar.`
);
