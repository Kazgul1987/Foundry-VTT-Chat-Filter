const MODULE_ID = "pf2e-chat-filter";
const FILTER_BUTTON_ID = `${MODULE_ID}-button`;
const FILTER_MENU_ID = `${MODULE_ID}-menu`;
const DEBUG = false;

class PF2eChatFilter {
  static selectedUserIds = new Set();
  static includeRelated = true;
  static identityCache = new Map();
  static relevanceCache = new Map();
  static observer = null;
  static observedChatLog = null;
  static button = null;
  static hookIds = [];
  static outsideClickHandler = null;
  static mountTimer = null;

  static init() {
    game.settings.register(MODULE_ID, "selectedUsers", {
      name: `${MODULE_ID}.settings.selectedUsers.name`,
      scope: "client",
      config: false,
      type: Array,
      default: []
    });
    game.settings.register(MODULE_ID, "includeRelated", {
      name: `${MODULE_ID}.settings.includeRelated.name`,
      scope: "client",
      config: false,
      type: Boolean,
      default: true
    });
  }

  static async ready() {
    const storedUsers = game.settings.get(MODULE_ID, "selectedUsers");
    const validUsers = Array.isArray(storedUsers)
      ? storedUsers.filter(id => typeof id === "string" && game.users?.get(id) && !game.users.get(id).isGM)
      : [];

    this.selectedUserIds = new Set(validUsers);
    this.includeRelated = Boolean(game.settings.get(MODULE_ID, "includeRelated"));

    if (validUsers.length !== (Array.isArray(storedUsers) ? storedUsers.length : 0)) {
      await game.settings.set(MODULE_ID, "selectedUsers", validUsers);
    }

    this.createButton();
    this.registerHooks();
    this.registerOutsideClick();
    this.scheduleMount();
  }

  static createButton() {
    if (this.button) return;
    const button = document.createElement("button");
    button.id = FILTER_BUTTON_ID;
    button.type = "button";
    button.classList.add("pf2e-chat-filter-button");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      this.createMenu();
    });
    this.button = button;
  }

  static registerHooks() {
    if (this.hookIds.length) return;

    for (const hookName of ["renderChatLog", "renderChatInput", "renderSidebar", "changeSidebarTab"]) {
      this.hookIds.push([hookName, Hooks.on(hookName, () => this.scheduleMount())]);
    }

    for (const hookName of [
      "createActor", "updateActor", "deleteActor",
      "createToken", "updateToken", "deleteToken",
      "createScene", "updateScene", "deleteScene"
    ]) {
      this.hookIds.push([hookName, Hooks.on(hookName, () => this.invalidateIdentityCaches())]);
    }

    this.hookIds.push(["deleteUser", Hooks.on("deleteUser", user => this.handleDeletedUser(user))]);
    this.hookIds.push(["deleteChatMessage", Hooks.on("deleteChatMessage", message => this.invalidateMessage(message?.id))]);
    this.hookIds.push(["updateChatMessage", Hooks.on("updateChatMessage", message => this.invalidateMessage(message?.id))]);
  }

  static registerOutsideClick() {
    if (this.outsideClickHandler) return;
    this.outsideClickHandler = event => {
      const menu = document.getElementById(FILTER_MENU_ID);
      if (!menu || menu.contains(event.target) || this.button?.contains(event.target)) return;
      menu.remove();
    };
    document.addEventListener("pointerdown", this.outsideClickHandler, true);
  }

  static scheduleMount() {
    window.clearTimeout(this.mountTimer);
    this.mountTimer = window.setTimeout(() => this.mountButton(), 0);
  }

  static getChatRoot() {
    const element = ui.chat?.element;
    if (element instanceof HTMLElement) return element;
    return element?.[0] instanceof HTMLElement ? element[0] : null;
  }

  static findAnchor() {
    const root = this.getChatRoot();
    if (!root) return null;
    return root.querySelector("#chat-controls .control-buttons")
      ?? root.querySelector(".chat-controls .control-buttons")
      ?? root.querySelector("#chat-controls")
      ?? root.querySelector(".chat-controls")
      ?? root.querySelector("#roll-privacy")?.parentElement
      ?? null;
  }

  static mountButton() {
    const anchor = this.findAnchor();
    if (!anchor || !this.button) return false;

    if (this.button.parentElement !== anchor) {
      this.adoptSiblingStyle(anchor);
      anchor.prepend(this.button);
    }

    this.attachObserver();
    this.updateButtonState();
    if (this.selectedUserIds.size) this.applyFilter();
    return true;
  }

  static adoptSiblingStyle(container) {
    const sibling = [...container.querySelectorAll("button")].find(element => element !== this.button);
    this.button.className = "pf2e-chat-filter-button";
    if (sibling) {
      const classes = [...sibling.classList].filter(name => !name.startsWith("fa-") && name !== "active");
      this.button.classList.add(...classes);
      const iconAsClass = [...sibling.classList].some(name => name.startsWith("fa-"));
      if (iconAsClass) {
        this.button.classList.add("fa-solid", "fa-filter");
        this.button.replaceChildren();
      } else {
        const icon = document.createElement("i");
        icon.className = "fa-solid fa-filter";
        this.button.replaceChildren(icon);
      }
    } else {
      this.button.classList.add("ui-control", "icon", "fa-solid", "fa-filter");
      this.button.replaceChildren();
    }
  }

  static attachObserver() {
    const chatLog = this.getChatRoot()?.querySelector("ol.chat-log");
    if (!chatLog || chatLog === this.observedChatLog) return;
    this.observer?.disconnect();
    this.observer = new MutationObserver(() => {
      if (this.selectedUserIds.size) this.applyFilter();
    });
    this.observer.observe(chatLog, { childList: true, subtree: false });
    this.observedChatLog = chatLog;
  }

  static getPlayers() {
    return [...(game.users ?? [])]
      .filter(user => !user.isGM)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }

  static selectedNames() {
    return [...this.selectedUserIds]
      .map(id => game.users?.get(id)?.name ?? id)
      .sort((a, b) => a.localeCompare(b));
  }

  static getMessageUserId(message) {
    return message?.author?.id ?? message?.user?.id ?? message?.user ?? null;
  }

  static getUserIdentifiers(userId) {
    if (this.identityCache.has(userId)) return this.identityCache.get(userId);
    const ids = new Set();
    const user = game.users?.get(userId);
    if (!user) {
      this.identityCache.set(userId, ids);
      return ids;
    }

    ids.add(user.id);
    const actors = [...(game.actors ?? [])].filter(actor => actor.testUserPermission(user, "OWNER"));
    if (user.character && !actors.includes(user.character)) actors.push(user.character);
    const actorIds = new Set();
    for (const actor of actors) {
      if (!actor) continue;
      actorIds.add(actor.id);
      if (actor.id) ids.add(actor.id);
      if (actor.uuid) ids.add(actor.uuid);
    }

    for (const scene of game.scenes ?? []) {
      for (const token of scene.tokens ?? []) {
        if (!actorIds.has(token.actorId)) continue;
        if (token.id) ids.add(token.id);
        if (token.uuid) ids.add(token.uuid);
      }
    }

    this.identityCache.set(userId, ids);
    this.debug("Identifiers", user.name, [...ids]);
    return ids;
  }

  static stringMatches(value, ids) {
    if (typeof value !== "string") return false;
    if (ids.has(value)) return true;
    return value.includes(".") && value.split(".").some(part => ids.has(part));
  }

  static flagsMatch(value, ids, depth = 0, seen = new WeakSet()) {
    if (value == null || depth > 6) return false;
    if (typeof value === "string") return this.stringMatches(value, ids);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    return values.some(entry => this.flagsMatch(entry, ids, depth + 1, seen));
  }

  static messageConcernsUser(message, userId) {
    if (this.getMessageUserId(message) === userId) return true;
    if (!this.includeRelated) return false;
    const cacheKey = `${message.id}:${userId}`;
    if (this.relevanceCache.has(cacheKey)) return this.relevanceCache.get(cacheKey);

    const ids = this.getUserIdentifiers(userId);
    const whisper = Array.isArray(message.whisper) ? message.whisper : [];
    const speaker = message.speaker ?? {};
    const result = whisper.includes(userId)
      || ids.has(speaker.actor)
      || ids.has(speaker.token)
      || this.flagsMatch(message.flags, ids);
    this.relevanceCache.set(cacheKey, result);
    return result;
  }

  static applyFilter() {
    const root = this.getChatRoot();
    if (!root) return;
    const active = [...this.selectedUserIds];
    for (const element of root.querySelectorAll(".chat-message")) {
      const message = game.messages?.get(element.dataset.messageId);
      const show = !message || !active.length || active.some(userId => this.messageConcernsUser(message, userId));
      element.hidden = !show;
      element.style.display = show ? "" : "none";
    }
    this.updateButtonState();
  }

  static async persistState() {
    await Promise.all([
      game.settings.set(MODULE_ID, "selectedUsers", [...this.selectedUserIds]),
      game.settings.set(MODULE_ID, "includeRelated", this.includeRelated)
    ]);
  }

  static updateButtonState() {
    if (!this.button) return;
    const active = this.selectedUserIds.size > 0;
    this.button.classList.toggle("active", active);
    this.button.setAttribute("aria-pressed", String(active));
    const key = active
      ? (this.includeRelated ? "buttonTitleRelated" : "buttonTitleOwn")
      : "filterChat";
    this.button.title = active
      ? game.i18n.format(`${MODULE_ID}.${key}`, { users: this.selectedNames().join(", ") })
      : game.i18n.localize(`${MODULE_ID}.${key}`);
    this.button.setAttribute("aria-label", this.button.title);
  }

  static createMenu() {
    const existing = document.getElementById(FILTER_MENU_ID);
    if (existing) {
      existing.remove();
      return;
    }

    const menu = document.createElement("div");
    menu.id = FILTER_MENU_ID;
    menu.className = "pf2e-chat-filter-menu";
    menu.setAttribute("role", "menu");
    document.body.append(menu);

    const render = () => {
      menu.replaceChildren();
      const header = document.createElement("div");
      header.className = "pf2e-chat-filter-header";
      header.textContent = this.selectedUserIds.size
        ? game.i18n.format(`${MODULE_ID}.filtered`, { users: this.selectedNames().join(", ") })
        : game.i18n.localize(`${MODULE_ID}.filterChat`);
      menu.append(header);

      this.addMenuEntry(menu, {
        label: game.i18n.localize(`${MODULE_ID}.allPlayers`),
        selected: !this.selectedUserIds.size,
        tooltip: game.i18n.localize(`${MODULE_ID}.resetFilter`),
        onClick: async () => {
          this.selectedUserIds.clear();
          await this.persistState();
          this.applyFilter();
          render();
        }
      });
      menu.append(this.createSeparator());

      for (const user of this.getPlayers()) {
        this.addMenuEntry(menu, {
          label: user.name,
          online: user.active,
          selected: this.selectedUserIds.has(user.id),
          tooltip: game.i18n.localize(`${MODULE_ID}.multipleSelection`),
          onClick: async () => {
            this.selectedUserIds.has(user.id) ? this.selectedUserIds.delete(user.id) : this.selectedUserIds.add(user.id);
            await this.persistState();
            this.applyFilter();
            render();
          }
        });
      }

      menu.append(this.createSeparator());
      this.addMenuEntry(menu, {
        label: game.i18n.localize(`${MODULE_ID}.includeRelated`),
        selected: this.includeRelated,
        tooltip: game.i18n.localize(`${MODULE_ID}.includeRelatedHint`),
        onClick: async () => {
          this.includeRelated = !this.includeRelated;
          this.relevanceCache.clear();
          await this.persistState();
          this.applyFilter();
          render();
        }
      });
    };

    render();
    this.positionMenu(menu);
  }

  static addMenuEntry(menu, { label, online = null, selected = false, tooltip = "", onClick }) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "pf2e-chat-filter-entry";
    entry.classList.toggle("is-selected", selected);
    entry.title = tooltip;
    entry.setAttribute("role", "menuitemcheckbox");
    entry.setAttribute("aria-checked", String(selected));

    const status = document.createElement("span");
    status.className = "pf2e-chat-filter-status";
    if (online !== null) {
      status.classList.add(online ? "pf2e-chat-filter-status-online" : "pf2e-chat-filter-status-offline");
      status.title = game.i18n.localize(`${MODULE_ID}.${online ? "online" : "offline"}`);
      const icon = document.createElement("i");
      icon.className = `${online ? "fa-solid" : "fa-regular"} fa-circle`;
      status.append(icon);
    }

    const text = document.createElement("span");
    text.className = "pf2e-chat-filter-label";
    text.textContent = label;
    const check = document.createElement("span");
    check.className = "pf2e-chat-filter-check";
    if (selected) {
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-check";
      check.append(icon);
    }
    entry.append(status, text, check);
    entry.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void onClick();
    });
    menu.append(entry);
  }

  static createSeparator() {
    const separator = document.createElement("hr");
    separator.className = "pf2e-chat-filter-separator";
    return separator;
  }

  static positionMenu(menu) {
    const rect = this.button?.getBoundingClientRect();
    if (!rect) return;
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right + 6;
    let top = rect.top;
    if (left + menuRect.width > window.innerWidth - 8) left = rect.left - menuRect.width - 6;
    if (top + menuRect.height > window.innerHeight - 8) top = rect.bottom - menuRect.height;
    const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - menuRect.height - 8);
    menu.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
  }

  static invalidateIdentityCaches() {
    this.identityCache.clear();
    this.relevanceCache.clear();
    if (this.selectedUserIds.size) this.applyFilter();
  }

  static invalidateMessage(messageId) {
    if (!messageId) return;
    for (const key of this.relevanceCache.keys()) {
      if (key.startsWith(`${messageId}:`)) this.relevanceCache.delete(key);
    }
    if (this.selectedUserIds.size) this.applyFilter();
  }

  static async handleDeletedUser(user) {
    if (!this.selectedUserIds.delete(user?.id)) return;
    this.invalidateIdentityCaches();
    await this.persistState();
  }

  static destroy() {
    window.clearTimeout(this.mountTimer);
    this.observer?.disconnect();
    this.observer = null;
    this.observedChatLog = null;
    document.getElementById(FILTER_MENU_ID)?.remove();
    this.button?.remove();
    this.button = null;
    if (this.outsideClickHandler) document.removeEventListener("pointerdown", this.outsideClickHandler, true);
    this.outsideClickHandler = null;
    for (const [hookName, hookId] of this.hookIds) Hooks.off(hookName, hookId);
    this.hookIds = [];
    this.identityCache.clear();
    this.relevanceCache.clear();
  }

  static debug(...args) {
    if (DEBUG) console.debug(`[${MODULE_ID}]`, ...args);
  }
}

Hooks.once("init", () => PF2eChatFilter.init());
Hooks.once("ready", () => PF2eChatFilter.ready());

export { PF2eChatFilter };
