const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Component,
  Modal,
  setIcon,
  MarkdownRenderChild,
  TFile,
  editorInfoField,
  editorLivePreviewField,
} = require("obsidian");

const {
  Decoration,
  ViewPlugin,
  WidgetType,
} = require("@codemirror/view");

const { syntaxTree } = require("@codemirror/language");

const DEFAULT_SETTINGS = {
  livePreview: true,
  refreshDebounceMs: 300,
  selectSuggesterThreshold: 24,
};

const CHOICE_SINGLE = new Set(["Select", "Cycle"]);
const CHOICE_MULTI = new Set(["Multi"]);
const LINK_SINGLE = new Set(["File", "Media"]);
const LINK_MULTI = new Set(["MultiFile", "MultiMedia"]);

const COMPLEX_TYPES = new Set([
  "Object",
  "ObjectList",
  "JSON",
  "YAML",
  "Canvas",
  "CanvasGroup",
  "CanvasGroupLink",
]);

// Supports both:
//   FCMB[chosename]
//   `FCMB[chosename]`
const FCMB_RE = /`FCMB\[([^\]\r\n]+)\]`|FCMB\[([^\]\r\n]+)\]/g;

function optionArg(value, label) {
  const v = String(value);
  if (label !== undefined && String(label) !== v) {
    return { name: "option", value: [v, String(label)] };
  }
  return { name: "option", value: [v] };
}

function simpleArg(name, value) {
  return { name, value: [String(value)] };
}

function selectionTouches(view, from, to) {
  return view.state.selection.ranges.some(
    (r) => r.from <= to && r.to >= from
  );
}

function isInsideBlockedSyntax(state, pos) {
  // We intentionally allow InlineCode so `FCMB[x]` also works.
  // We only suppress fenced/code blocks, YAML/frontmatter, and raw HTML blocks.
  let node;
  try {
    node = syntaxTree(state).resolveInner(pos, 1);
  } catch {
    return false;
  }

  while (node) {
    const name = String(node.name || "").toLowerCase();
    if (
      name.includes("frontmatter") ||
      name.includes("yaml") ||
      name.includes("codeblock") ||
      name.includes("fencedcode") ||
      name.includes("htmlblock")
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}


function normalizeMultiValue(value) {
  const raw = Array.isArray(value)
    ? value
    : value == null || value === ""
      ? []
      : [value];

  const result = [];
  const seen = new Set();

  for (const item of raw) {
    const normalized = String(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

class FCMBMultiSelectModal extends Modal {
  constructor(app, candidates, selectedValues, onToggle) {
    super(app);
    this.candidates = [...new Set((candidates ?? []).map(String))];
    this.selected = new Set((selectedValues ?? []).map(String));
    this.onToggle = onToggle;

    this.query = "";
    this.visible = [];
    this.activeIndex = 0;

    this.inputEl = null;
    this.listEl = null;
  }

  onOpen() {
    const { modalEl, contentEl } = this;

    // Reuse Obsidian's prompt/suggestion DOM classes so themes and the
    // current Obsidian UI variables style this like native suggesters.
    modalEl.addClass("fcmb-native-prompt-modal");
    contentEl.empty();
    contentEl.addClass("fcmb-native-prompt-content");

    const inputContainer = contentEl.createDiv({
      cls: "prompt-input-container",
    });

    this.inputEl = inputContainer.createEl("input", {
      cls: "prompt-input",
      attr: {
        type: "text",
        placeholder: "搜索候选项…",
        autocomplete: "off",
        spellcheck: "false",
      },
    });

    const results = contentEl.createDiv({
      cls: "prompt-results",
    });

    this.listEl = results.createDiv({
      cls: "suggestion",
    });

    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl.value ?? "";
      this.activeIndex = 0;
      this.renderList();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (this.visible.length) {
          this.activeIndex =
            (this.activeIndex + 1) % this.visible.length;
          this.renderList();
        }
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (this.visible.length) {
          this.activeIndex =
            (this.activeIndex - 1 + this.visible.length) %
            this.visible.length;
          this.renderList();
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const value = this.visible[this.activeIndex];
        if (value != null) void this.toggleValue(value);
        return;
      }

      // Escape deliberately bubbles to Obsidian Modal's native close logic.
    });

    this.renderList();

    window.setTimeout(() => {
      this.inputEl?.focus();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
    this.inputEl = null;
    this.listEl = null;
    this.visible = [];
  }

  matchesQuery(value) {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return true;
    return value.toLocaleLowerCase().includes(query);
  }

  appendHighlightedLabel(parent, value) {
    const query = this.query.trim();
    if (!query) {
      parent.setText(value);
      return;
    }

    const lowerValue = value.toLocaleLowerCase();
    const lowerQuery = query.toLocaleLowerCase();
    const index = lowerValue.indexOf(lowerQuery);

    if (index < 0) {
      parent.setText(value);
      return;
    }

    if (index > 0) {
      parent.appendText(value.slice(0, index));
    }

    parent.createSpan({
      cls: "suggestion-highlight",
      text: value.slice(index, index + query.length),
    });

    if (index + query.length < value.length) {
      parent.appendText(value.slice(index + query.length));
    }
  }

  async toggleValue(value) {
    const nextSelected = !this.selected.has(value);

    if (nextSelected) this.selected.add(value);
    else this.selected.delete(value);

    try {
      await this.onToggle(value, nextSelected);
    } catch (error) {
      console.error("FCMB multi toggle failed", {
        value,
        nextSelected,
        error,
      });

      new Notice(
        `更新“${value}”失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );

      if (nextSelected) this.selected.delete(value);
      else this.selected.add(value);
    }

    // Do not close: repaint and continue multi-selecting.
    this.renderList();
    this.inputEl?.focus();
  }

  renderList() {
    if (!this.listEl) return;

    this.listEl.empty();

    this.visible = this.candidates.filter((value) =>
      this.matchesQuery(value)
    );

    if (this.visible.length === 0) {
      this.listEl.createDiv({
        cls: "suggestion-empty",
        text: "没有匹配的候选项",
      });
      return;
    }

    if (this.activeIndex >= this.visible.length) {
      this.activeIndex = this.visible.length - 1;
    }
    if (this.activeIndex < 0) this.activeIndex = 0;

    this.visible.forEach((value, index) => {
      const checked = this.selected.has(value);

      const row = this.listEl.createDiv({
        cls:
          "suggestion-item mod-complex fcmb-native-suggestion" +
          (index === this.activeIndex ? " is-selected" : "") +
          (checked ? " fcmb-is-checked" : ""),
        attr: {
          role: "option",
          "aria-selected": checked ? "true" : "false",
        },
      });

      const content = row.createDiv({
        cls: "suggestion-content",
      });

      const title = content.createDiv({
        cls: "suggestion-title",
      });
      this.appendHighlightedLabel(title, value);

      const aux = row.createDiv({
        cls: "suggestion-aux",
      });

      const flair = aux.createSpan({
        cls: "suggestion-flair fcmb-check-flair",
        attr: {
          "aria-hidden": "true",
        },
      });

      if (checked) {
        setIcon(flair, "check");
      }

      row.addEventListener("mouseenter", () => {
        if (this.activeIndex === index) return;
        this.activeIndex = index;

        for (const sibling of this.listEl.children) {
          sibling.classList?.remove("is-selected");
        }
        row.addClass("is-selected");
      });

      row.addEventListener("mousedown", (event) => {
        // Prevent the search input from losing focus before click completes.
        event.preventDefault();
      });

      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.activeIndex = index;
        void this.toggleValue(value);
      });

      if (index === this.activeIndex) {
        window.requestAnimationFrame(() => {
          row.scrollIntoView({
            block: "nearest",
          });
        });
      }
    });
  }
}
class ControlMount {
  constructor(plugin, container, filePath, fieldName) {
    this.plugin = plugin;
    this.container = container;
    this.filePath = filePath;
    this.fieldName = fieldName;

    this.mountable = null;
    this.customComponent = null;
    this.customBindTarget = null;
    this.customCandidates = [];
    this.customRenderScheduled = false;

    this.disposed = false;
    this.generation = 0;

    this.plugin.registerMount(this);

    // CodeMirror calls WidgetType.toDOM() before the returned DOM node is
    // attached to the editor. Do not require container.isConnected here.
    void this.refresh();
  }

  cleanupRenderedControl() {
    if (this.mountable) {
      try {
        this.mountable.unmount();
      } catch (e) {
        console.warn("FCMB: failed to unmount old Meta Bind control", e);
      }
      this.mountable = null;
    }

    if (this.customComponent) {
      try {
        this.customComponent.unload();
      } catch (e) {
        console.warn("FCMB: failed to unload custom control", e);
      }
      this.customComponent = null;
    }

    this.customBindTarget = null;
    this.customCandidates = [];
    this.customRenderScheduled = false;
  }

  async refresh() {
    if (this.disposed) return;

    const generation = ++this.generation;
    this.cleanupRenderedControl();

    this.container.empty?.();
    this.container.classList.add("fcmb-control");
    this.container.classList.remove("fcmb-error");
    this.container.dataset.fcmbField = this.fieldName;

    const loading = document.createElement("span");
    loading.className = "fcmb-loading";
    loading.textContent = "…";
    this.container.appendChild(loading);

    try {
      const built = await this.plugin.buildMetaBindDeclaration(
        this.filePath,
        this.fieldName
      );

      if (this.disposed || generation !== this.generation) return;

      this.container.empty?.();

      if (built.customControl === "multi") {
        this.mountCustomMulti(built);
        this.container.title =
          `FCMB · ${this.fieldName} · Fileclass Multi`;
        return;
      }

      const mb = this.plugin.getMetaBindApi();
      if (!mb) {
        throw new Error("Meta Bind API 不可用。");
      }

      const mountable = mb.createInputFieldMountable(this.filePath, {
        declaration: built.declaration,
        renderChildType: "inline",
      });

      if (!mountable || typeof mountable.mount !== "function") {
        throw new Error(
          "Meta Bind 没有返回可挂载的 Input Field；请检查 Meta Bind 版本。"
        );
      }

      mountable.mount(this.container);
      this.mountable = mountable;

      this.container.title =
        `FCMB · ${this.fieldName} · Fileclass ${built.fileclassType}`;

      requestAnimationFrame(() => {
        if (
          !this.disposed &&
          generation === this.generation &&
          this.mountable === mountable &&
          this.container.childNodes.length === 0
        ) {
          console.error("FCMB: Meta Bind mounted but produced no DOM", {
            filePath: this.filePath,
            fieldName: this.fieldName,
            built,
          });
          this.container.classList.add("fcmb-error");
          this.container.textContent =
            `FCMB[${this.fieldName}] ⚠ Meta Bind 已挂载，但没有生成可见控件`;
        }
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;

      this.container.empty?.();
      this.container.classList.add("fcmb-error");
      const message =
        error instanceof Error ? error.message : String(error);
      this.container.textContent = `FCMB[${this.fieldName}] ⚠ ${message}`;
      console.error("FCMB render failed", {
        filePath: this.filePath,
        fieldName: this.fieldName,
        error,
      });
    }
  }

  mountCustomMulti(built) {
    const mb = this.plugin.getMetaBindApi();
    if (!mb) {
      throw new Error("Meta Bind API 不可用。");
    }

    const component = new Component();
    component.load();
    this.customComponent = component;
    this.customBindTarget = built.bindTarget;
    this.customCandidates = [
      ...new Set((built.allowedValues ?? []).map(String)),
    ];

    // Keep the chips in sync when the Properties UI, another FCMB control,
    // or another Meta Bind field changes the same frontmatter property.
    if (typeof mb.subscribeToMetadata === "function") {
      mb.subscribeToMetadata(
        this.customBindTarget,
        component,
        () => this.scheduleCustomMultiRender()
      );
    }

    // A Fileclass Multi represents a set-like selection. If old data already
    // contains duplicate values, normalize it once when the FCMB control mounts.
    const raw = mb.getMetadata(this.customBindTarget);
    const normalized = normalizeMultiValue(raw);

    if (Array.isArray(raw) && !sameStringArray(raw, normalized)) {
      mb.setMetadata(this.customBindTarget, normalized);
    }

    this.renderCustomMulti();
  }

  scheduleCustomMultiRender() {
    if (this.disposed || this.customRenderScheduled) return;
    this.customRenderScheduled = true;

    requestAnimationFrame(() => {
      this.customRenderScheduled = false;
      if (!this.disposed) this.renderCustomMulti();
    });
  }

  renderCustomMulti() {
    if (
      this.disposed ||
      !this.customBindTarget ||
      !this.customComponent
    ) {
      return;
    }

    const mb = this.plugin.getMetaBindApi();
    if (!mb) return;

    const selected = normalizeMultiValue(
      mb.getMetadata(this.customBindTarget)
    );

    this.container.empty?.();
    this.container.classList.add("fcmb-multi-control");

    const chips = this.container.createSpan({
      cls: "fcmb-multi-chips",
    });

    for (const value of selected) {
      const chip = chips.createSpan({
        cls: "fcmb-multi-chip",
      });
      chip.dataset.value = value;

      chip.createSpan({
        cls: "fcmb-multi-chip-label",
        text: value,
      });

      const remove = chip.createEl("button", {
        cls: "fcmb-multi-remove",
        text: "×",
        attr: {
          type: "button",
          "aria-label": `移除 ${value}`,
          title: `移除 ${value}`,
        },
      });

      remove.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        mb.updateMetadata(this.customBindTarget, (current) =>
          normalizeMultiValue(current).filter(
            (item) => item !== value
          )
        );
      });
    }

    const addButton = this.container.createEl("button", {
      cls: "fcmb-multi-add",
      text: "+",
      attr: {
        type: "button",
        "aria-label": `为 ${this.fieldName} 添加选项`,
        title: `为 ${this.fieldName} 添加选项`,
      },
    });

    addButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    addButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const current = normalizeMultiValue(
        mb.getMetadata(this.customBindTarget)
      );

      const modal = new FCMBMultiSelectModal(
        this.plugin.app,
        this.customCandidates,
        current,
        async (value, shouldSelect) => {
          mb.updateMetadata(this.customBindTarget, (oldValue) => {
            let list = normalizeMultiValue(oldValue);

            if (shouldSelect) {
              if (!list.includes(value)) list.push(value);
            } else {
              list = list.filter((item) => item !== value);
            }

            return list;
          });
        }
      );

      modal.open();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.plugin.unregisterMount(this);
    this.cleanupRenderedControl();
  }
}
class FCMBMarkdownChild extends MarkdownRenderChild {
  constructor(plugin, containerEl, filePath, fieldName) {
    super(containerEl);
    this.plugin = plugin;
    this.filePath = filePath;
    this.fieldName = fieldName;
    this.mount = null;
  }

  onload() {
    this.mount = new ControlMount(
      this.plugin,
      this.containerEl,
      this.filePath,
      this.fieldName
    );
  }

  onunload() {
    this.mount?.dispose();
    this.mount = null;
  }
}

class FCMBWidget extends WidgetType {
  constructor(plugin, filePath, fieldName) {
    super();
    this.plugin = plugin;
    this.filePath = filePath;
    this.fieldName = fieldName;
  }

  eq(other) {
    return (
      other instanceof FCMBWidget &&
      other.plugin === this.plugin &&
      other.filePath === this.filePath &&
      other.fieldName === this.fieldName
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "fcmb-live-widget";
    span.contentEditable = "false";

    const mount = new ControlMount(
      this.plugin,
      span,
      this.filePath,
      this.fieldName
    );
    this.plugin.liveDomMounts.set(span, mount);
    return span;
  }

  destroy(dom) {
    const mount = this.plugin.liveDomMounts.get(dom);
    if (mount) {
      mount.dispose();
      this.plugin.liveDomMounts.delete(dom);
    }
  }
}

function makeLivePreviewExtension(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.filePath = this.getFilePath(view);
        this.decorations = this.build(view);
      }

      getFilePath(view) {
        try {
          return view.state.field(editorInfoField, false)?.file?.path ?? "";
        } catch {
          return "";
        }
      }

      update(update) {
        const nowFile = this.getFilePath(update.view);
        const fileChanged = nowFile !== this.filePath;
        if (fileChanged) this.filePath = nowFile;

        let livePreview = false;
        try {
          livePreview = Boolean(
            update.view.state.field(editorLivePreviewField, false)
          );
        } catch {}

        if (!plugin.settings.livePreview || !livePreview) {
          if (this.decorations !== Decoration.none) {
            this.decorations = Decoration.none;
          }
          return;
        }

        if (
          fileChanged ||
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged
        ) {
          this.decorations = this.build(update.view);
        }
      }

      build(view) {
        if (!plugin.settings.livePreview) return Decoration.none;

        let livePreview = false;
        try {
          livePreview = Boolean(
            view.state.field(editorLivePreviewField, false)
          );
        } catch {}
        if (!livePreview) return Decoration.none;

        const filePath = this.getFilePath(view);
        if (!filePath) return Decoration.none;

        const ranges = [];

        for (const visible of view.visibleRanges) {
          const text = view.state.doc.sliceString(visible.from, visible.to);
          FCMB_RE.lastIndex = 0;

          let match;
          while ((match = FCMB_RE.exec(text))) {
            const fieldName = String(match[1] ?? match[2] ?? "").trim();
            if (!fieldName) continue;

            const from = visible.from + match.index;
            const to = from + match[0].length;

            if (selectionTouches(view, from, to)) continue;
            if (isInsideBlockedSyntax(view.state, from)) continue;

            ranges.push(
              Decoration.replace({
                widget: new FCMBWidget(
                  plugin,
                  filePath,
                  fieldName
                ),
                inclusive: false,
              }).range(from, to)
            );
          }
        }

        return Decoration.set(ranges, true);
      }
    },
    {
      decorations: (instance) => instance.decorations,
    }
  );
}

class FCMBSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Live Preview rendering")
      .setDesc("Render FCMB[field] controls directly in Live Preview.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.livePreview)
          .onChange(async (value) => {
            this.plugin.settings.livePreview = value;
            await this.plugin.saveSettings();
            this.app.workspace.updateOptions();
          })
      );

    new Setting(containerEl)
      .setName("Candidate refresh debounce")
      .setDesc(
        "Milliseconds to wait before re-reading Fileclass/Base candidates after vault changes."
      )
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.refreshDebounceMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 50 && n <= 5000) {
              this.plugin.settings.refreshDebounceMs = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Select → suggester threshold")
      .setDesc(
        "Fileclass Select/Cycle fields use inlineSelect below this count and fuzzy suggester above it."
      )
      .addText((text) =>
        text
          .setPlaceholder("24")
          .setValue(String(this.plugin.settings.selectSuggesterThreshold))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 1 && n <= 10000) {
              this.plugin.settings.selectSuggesterThreshold = n;
              await this.plugin.saveSettings();
              this.plugin.refreshAll();
            }
          })
      );
  }
}

module.exports = class FileclassMetaBindPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.mounts = new Set();
    this.liveDomMounts = new WeakMap();
    this.pendingPaths = new Set();
    this.refreshTimer = null;

    this.addSettingTab(new FCMBSettingTab(this.app, this));

    this.addCommand({
      id: "refresh-controls",
      name: "Refresh FCMB controls",
      callback: () => {
        this.refreshAll();
        new Notice("FCMB controls refreshed.");
      },
    });

    this.addCommand({
      id: "diagnose-dependencies",
      name: "Diagnose FCMB dependencies",
      callback: () => {
        const fc = this.getFileclassApi();
        const mb = this.getMetaBindApi();
        const active = this.app.workspace.getActiveFile();
        const message = [
          `Fileclass API: ${fc ? "OK" : "MISSING"}`,
          `Meta Bind API: ${mb ? "OK" : "MISSING"}`,
          `Active file: ${active?.path ?? "(none)"}`,
          `Mounted FCMB controls: ${this.mounts?.size ?? 0}`,
        ].join("\\n");
        console.log("FCMB diagnostics", {
          fileclassApi: fc,
          metaBindApi: mb,
          activeFile: active?.path ?? null,
          mounts: this.mounts?.size ?? 0,
        });
        new Notice(message, 8000);
      },
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.processReadingView(el, ctx);
    });

    this.registerEditorExtension(makeLivePreviewExtension(this));

    // A .base can change directly; candidate notes can also enter/leave a Base
    // because they are created/renamed/deleted or their metadata changes.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.scheduleRefresh(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.scheduleRefresh(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.scheduleRefresh(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.scheduleRefresh(oldPath);
        if (file instanceof TFile) this.scheduleRefresh(file.path);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) this.scheduleRefresh(file.path);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      const missing = [];
      if (!this.getFileclassApi()) missing.push("Fileclass");
      if (!this.getMetaBindApi()) missing.push("Meta Bind");
      if (missing.length) {
        new Notice(
          `Fileclass Meta Bind: 请启用 ${missing.join("、")}。`,
          7000
        );
      }
    });
  }

  onunload() {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const mount of [...(this.mounts ?? [])]) {
      mount.dispose();
    }
    this.mounts?.clear?.();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) ?? {}
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getFileclassApi() {
    return this.app.plugins.getPlugin("fileclass")?.api ??
      this.app.plugins.plugins?.fileclass?.api;
  }

  getMetaBindApi() {
    return this.app.plugins.getPlugin("obsidian-meta-bind-plugin")?.api ??
      this.app.plugins.plugins?.["obsidian-meta-bind-plugin"]?.api;
  }

  registerMount(mount) {
    this.mounts.add(mount);
  }

  unregisterMount(mount) {
    this.mounts.delete(mount);
  }

  scheduleRefresh(path) {
    if (path) this.pendingPaths.add(path);

    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const changed = new Set(this.pendingPaths);
      this.pendingPaths.clear();
      this.refreshForPaths(changed);
    }, this.settings.refreshDebounceMs);
  }

  refreshForPaths(changedPaths) {
    const baseChanged = [...changedPaths].some((p) =>
      String(p).toLowerCase().endsWith(".base")
    );

    for (const mount of [...this.mounts]) {
      // Always refresh when the Base itself changes.
      if (baseChanged) {
        void mount.refresh();
        continue;
      }

      // Refresh if another file changed. This catches:
      // - candidate note create/delete/rename
      // - candidate frontmatter changes that affect Base filters/sorts
      // - Fileclass schema changes
      //
      // Avoid remounting the control while its own bound note is being edited,
      // because Meta Bind itself writes that file during interaction.
      const externalChange = [...changedPaths].some(
        (p) => p !== mount.filePath
      );
      if (externalChange) {
        void mount.refresh();
      }
    }
  }

  refreshAll() {
    for (const mount of [...this.mounts]) {
      void mount.refresh();
    }
  }

  async getSchemaField(fc, fieldInfo) {
    if (!fieldInfo?.owner) return null;
    const schema = await fc.getSchema(fieldInfo.owner);
    if (!schema?.fields) return null;
    return (
      schema.fields.find(
        (f) =>
          f.name === fieldInfo.name &&
          (f.path === "" || f.path == null)
      ) ?? null
    );
  }

  async buildMetaBindDeclaration(filePath, fieldName) {
    const fc = this.getFileclassApi();
    const mb = this.getMetaBindApi();

    if (!fc) {
      throw new Error("Fileclass API 不可用；请启用/更新 Fileclass。");
    }
    if (!mb) {
      throw new Error("Meta Bind API 不可用；请启用 Meta Bind。");
    }

    const fields = await fc.getFields(filePath);
    const fieldInfo = fields.find(
      (f) => f.isRoot && f.name === fieldName
    );

    if (!fieldInfo) {
      throw new Error(
        `当前笔记的 Fileclass Schema 中没有根字段 "${fieldName}"。`
      );
    }

    const schemaField = await this.getSchemaField(fc, fieldInfo);
    const args = [];
    let inputFieldType = "text";

    if (CHOICE_SINGLE.has(fieldInfo.type)) {
      const values = await fc.allowedValues(filePath, fieldName);

      if (values.length === 0) {
        inputFieldType = "text";
      } else {
        inputFieldType =
          values.length > this.settings.selectSuggesterThreshold
            ? "suggester"
            : "inlineSelect";
        for (const value of values) {
          args.push(optionArg(value));
        }
      }
    } else if (CHOICE_MULTI.has(fieldInfo.type)) {
      const values = await fc.allowedValues(filePath, fieldName);
      const bindTarget = mb.createBindTarget(
        "frontmatter",
        filePath,
        [fieldName]
      );

      return {
        fileclassType: fieldInfo.type,
        customControl: "multi",
        bindTarget,
        allowedValues: [...new Set((values ?? []).map(String))],
      };
    } else if (LINK_SINGLE.has(fieldInfo.type)) {
      const candidates = await fc.fileCandidates(
        filePath,
        fieldName
      );
      inputFieldType = "suggester";
      for (const candidate of candidates) {
        args.push(optionArg(candidate.link, candidate.display));
      }
    } else if (LINK_MULTI.has(fieldInfo.type)) {
      const candidates = await fc.fileCandidates(
        filePath,
        fieldName
      );
      inputFieldType = "inlineListSuggester";
      for (const candidate of candidates) {
        args.push(optionArg(candidate.link, candidate.display));
      }
    } else {
      switch (fieldInfo.type) {
        case "Input": {
          const opts = schemaField?.options ?? {};
          const multiline =
            opts.multiLine === true ||
            opts.multiline === true ||
            opts["multi-line"] === true;
          inputFieldType = multiline ? "textArea" : "text";
          break;
        }
        case "MultiInput":
        case "CycleDuration":
          inputFieldType = "inlineList";
          break;
        case "Number": {
          inputFieldType = "number";
          const opts = schemaField?.options ?? {};
          if (Number.isFinite(Number(opts.min))) {
            args.push(simpleArg("minValue", Number(opts.min)));
          }
          if (Number.isFinite(Number(opts.max))) {
            args.push(simpleArg("maxValue", Number(opts.max)));
          }
          if (Number.isFinite(Number(opts.step))) {
            args.push(simpleArg("stepSize", Number(opts.step)));
          }
          break;
        }
        case "Boolean":
          inputFieldType = "toggle";
          break;
        case "Date":
          inputFieldType = "datePicker";
          break;
        case "DateTime":
          inputFieldType = "dateTime";
          break;
        case "Time":
          inputFieldType = "time";
          break;
        case "Duration":
        case "Location":
        case "Icon":
        case "Color":
          inputFieldType = "text";
          break;
        default:
          if (COMPLEX_TYPES.has(fieldInfo.type)) {
            throw new Error(
              `${fieldInfo.type} 暂不自动映射；请继续使用 Fileclass 自己的嵌套/结构化编辑器。`
            );
          }
          inputFieldType = "text";
      }
    }

    return {
      fileclassType: fieldInfo.type,
      declaration: {
        inputFieldType,
        bindTarget: mb.createBindTarget(
          "frontmatter",
          filePath,
          [fieldName]
        ),
        arguments: args,
      },
    };
  }

  processReadingView(el, ctx) {
    const sourcePath = ctx.sourcePath;
    if (!sourcePath) return;

    // First handle inline-code form: `FCMB[field]`
    const codeEls = [...el.querySelectorAll("code")].filter(
      (code) => !code.closest("pre") && !code.closest(".fcmb-control")
    );

    for (const code of codeEls) {
      const text = code.textContent ?? "";
      const match = text.match(/^FCMB\[([^\]\r\n]+)\]$/);
      if (!match) continue;

      const fieldName = String(match[1] ?? "").trim();
      if (!fieldName) continue;

      const placeholder = document.createElement("span");
      code.replaceWith(placeholder);
      ctx.addChild(
        new FCMBMarkdownChild(
          this,
          placeholder,
          sourcePath,
          fieldName
        )
      );
    }

    // Then handle literal plain-text form: FCMB[field]
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (
            parent.closest(
              "code, pre, a, script, style, .fcmb-control, .fcmb-live-widget"
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.nodeValue ?? "").includes("FCMB[")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue ?? "";
      FCMB_RE.lastIndex = 0;

      let match;
      let cursor = 0;
      let changed = false;
      const fragment = document.createDocumentFragment();
      const children = [];

      while ((match = FCMB_RE.exec(text))) {
        const fieldName = String(
          match[1] ?? match[2] ?? ""
        ).trim();
        if (!fieldName) continue;

        changed = true;
        if (match.index > cursor) {
          fragment.appendChild(
            document.createTextNode(
              text.slice(cursor, match.index)
            )
          );
        }

        const placeholder = document.createElement("span");
        fragment.appendChild(placeholder);
        children.push({ placeholder, fieldName });
        cursor = match.index + match[0].length;
      }

      if (!changed) continue;

      if (cursor < text.length) {
        fragment.appendChild(
          document.createTextNode(text.slice(cursor))
        );
      }

      node.parentNode?.replaceChild(fragment, node);

      for (const child of children) {
        ctx.addChild(
          new FCMBMarkdownChild(
            this,
            child.placeholder,
            sourcePath,
            child.fieldName
          )
        );
      }
    }
  }
};
