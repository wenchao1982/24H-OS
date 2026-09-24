/*
 * PPT 工作台 · Skill UI 前端逻辑。
 * 沙箱约束：CSP connect-src 'none' —— 不发起任何网络请求，一切能力只走 postMessage RPC。
 */
(function () {
  "use strict";

  /* ----------------------------- RPC 客户端 ----------------------------- */

  var hostInfo = null;
  var rpcSeq = 0;
  var pending = Object.create(null);
  var inHost = window.parent && window.parent !== window;
  var RPC_TIMEOUT_MS = 20000;

  function log(kind, text) {
    var el = document.getElementById("log");
    if (!el) return;
    var line = document.createElement("div");
    line.className = "log-line log-" + kind;
    var time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = "[" + time + "] " + text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      if (!inHost) {
        reject(new Error("未在宿主 iframe 中运行，无法调用 RPC。"));
        return;
      }
      var id = "ui-" + ++rpcSeq;
      var startedAt = (window.performance || Date).now();
      var timer = window.setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          var ms = Math.round(((window.performance || Date).now()) - startedAt);
          log("error", method + " 超时（" + ms + "ms）");
          reject(new Error("RPC 超时：" + method));
        }
      }, RPC_TIMEOUT_MS);

      pending[id] = { resolve: resolve, reject: reject, method: method, startedAt: startedAt, timer: timer, params: params };
      window.parent.postMessage({ __24os: true, id: id, method: method, params: params || {} }, "*");
      log("send", method + " → " + summarize(params));
    });
  }

  function summarize(value) {
    if (value === undefined || value === null) return "";
    try {
      var json = JSON.stringify(value);
      return json.length > 90 ? json.slice(0, 90) + "…" : json;
    } catch (error) {
      return String(value);
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__24os !== true) return;

    if (data.type === "host.init") {
      hostInfo = data.payload || {};
      log("ok", "握手 host.init（capabilities=" + ((hostInfo.capabilities || []).join(",") || "无") + "）");
      // 回执：告知宿主 UI 已就绪。
      window.parent.postMessage({ __24os: true, type: "ui.ready" }, "*");
      renderBanner();
      return;
    }

    if (data.id == null) return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    window.clearTimeout(entry.timer);
    var ms = Math.round(((window.performance || Date).now()) - entry.startedAt);

    if (data.ok) {
      log("ok", entry.method + " ✓ " + ms + "ms " + summarize(data.result));
      entry.resolve(data.result);
    } else {
      var message = (data.error && data.error.message) || "RPC 失败";
      log("error", entry.method + " ✗ " + ms + "ms " + message);
      entry.reject(new Error(message));
    }
  });

  function renderBanner() {
    var banner = document.getElementById("banner");
    if (!inHost) {
      banner.hidden = false;
      banner.className = "banner warn";
      banner.textContent = "当前不在宿主 iframe 中，RPC 能力不可用（请从 24H-OS 打开）。";
    } else if (hostInfo) {
      banner.hidden = true;
    }
  }

  /* ------------------------------- 状态 -------------------------------- */

  var TEMPLATES = [
    { id: "minimal", name: "简约", desc: "留白 · 细线 · 浅色" },
    { id: "business", name: "商务", desc: "深色 · 稳重 · 高对比" },
    { id: "vivid", name: "活泼", desc: "渐变 · 圆角 · 明快" }
  ];

  var state = {
    template: "minimal",
    themeColor: "#4C8DFF",
    active: 0,
    slides: [
      {
        title: "24H-OS · 功能性 Skill",
        subtitle: "自带 UI 的 Skill，在沙箱 iframe 中由宿主注入能力",
        bullets: ["纯前端 UI，遵守严格 CSP", "通过 postMessage RPC 调宿主", "一键生成真实 PPTX"]
      },
      {
        title: "协议要点",
        subtitle: "24os-skill-ui/1",
        bullets: ["manifest 声明 capabilities / permissions", "宿主按 id 关联请求与响应", "文件读写限制在同 skill 工作区"]
      }
    ]
  };

  function activeSlide() {
    return state.slides[state.active];
  }

  /* ------------------------------ 渲染 -------------------------------- */

  function renderTemplates() {
    var wrap = document.getElementById("templates");
    wrap.innerHTML = "";
    TEMPLATES.forEach(function (tpl) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "tpl" + (state.template === tpl.id ? " active" : "");
      item.dataset.tpl = tpl.id;

      var thumb = document.createElement("div");
      thumb.className = "tpl-thumb tpl-" + tpl.id;
      var bar = document.createElement("span");
      bar.className = "tpl-bar";
      bar.style.background = state.themeColor;
      thumb.appendChild(bar);
      var lines = document.createElement("span");
      lines.className = "tpl-lines";
      thumb.appendChild(lines);

      var meta = document.createElement("div");
      meta.className = "tpl-meta";
      var name = document.createElement("strong");
      name.textContent = tpl.name;
      var desc = document.createElement("span");
      desc.textContent = tpl.desc;
      meta.appendChild(name);
      meta.appendChild(desc);

      item.appendChild(thumb);
      item.appendChild(meta);
      item.addEventListener("click", function () {
        state.template = tpl.id;
        renderTemplates();
        renderPreview();
      });
      wrap.appendChild(item);
    });
  }

  function renderSlideList() {
    var list = document.getElementById("slide-list");
    list.innerHTML = "";
    state.slides.forEach(function (slide, index) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slide-item" + (index === state.active ? " active" : "");
      var num = document.createElement("span");
      num.className = "slide-num";
      num.textContent = String(index + 1);
      var label = document.createElement("span");
      label.className = "slide-label";
      label.textContent = slide.title || "（未命名）";
      var del = document.createElement("span");
      del.className = "slide-del";
      del.textContent = "×";
      del.title = "删除此页";
      del.addEventListener("click", function (event) {
        event.stopPropagation();
        removeSlide(index);
      });
      btn.appendChild(num);
      btn.appendChild(label);
      btn.appendChild(del);
      btn.addEventListener("click", function () {
        state.active = index;
        renderSlideList();
        renderEditor();
        renderPreview();
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function renderEditor() {
    var wrap = document.getElementById("editor");
    wrap.innerHTML = "";
    var slide = activeSlide();

    wrap.appendChild(field("标题", "input", slide.title, function (value) {
      slide.title = value;
      renderSlideList();
      renderPreview();
    }));
    wrap.appendChild(field("副标题", "input", slide.subtitle, function (value) {
      slide.subtitle = value;
      renderPreview();
    }));
    wrap.appendChild(
      field("要点（每行一条）", "textarea", (slide.bullets || []).join("\n"), function (value) {
        slide.bullets = value.split("\n").map(function (line) {
          return line.replace(/^\s*[-*]\s*/, "");
        }).filter(function (line) {
          return line.trim().length > 0;
        });
        renderPreview();
      })
    );
  }

  function field(labelText, kind, value, onChange) {
    var wrap = document.createElement("label");
    wrap.className = "field";
    var label = document.createElement("span");
    label.className = "field-label";
    label.textContent = labelText;
    var input;
    if (kind === "textarea") {
      input = document.createElement("textarea");
      input.rows = 5;
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.value = value || "";
    input.addEventListener("input", function () {
      onChange(input.value);
    });
    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  }

  function renderPreview() {
    var preview = document.getElementById("preview");
    var slide = activeSlide();
    preview.className = "preview tpl-" + state.template;
    preview.style.setProperty("--theme", state.themeColor);
    preview.innerHTML = "";

    var bar = document.createElement("div");
    bar.className = "preview-bar";
    bar.style.background = state.themeColor;
    preview.appendChild(bar);

    var inner = document.createElement("div");
    inner.className = "preview-inner";

    var title = document.createElement("h2");
    title.className = "preview-title";
    title.textContent = slide.title || "";
    inner.appendChild(title);

    if (slide.subtitle) {
      var subtitle = document.createElement("p");
      subtitle.className = "preview-subtitle";
      subtitle.textContent = slide.subtitle;
      inner.appendChild(subtitle);
    }

    if (slide.bullets && slide.bullets.length > 0) {
      var ul = document.createElement("ul");
      ul.className = "preview-bullets";
      slide.bullets.forEach(function (text) {
        var li = document.createElement("li");
        li.textContent = text;
        ul.appendChild(li);
      });
      inner.appendChild(ul);
    }

    preview.appendChild(inner);

    var page = document.createElement("div");
    page.className = "preview-page";
    page.textContent = (state.active + 1) + " / " + state.slides.length;
    preview.appendChild(page);
  }

  /* ------------------------------ 操作 -------------------------------- */

  function addSlide() {
    state.slides.push({ title: "新幻灯片", subtitle: "", bullets: ["新要点"] });
    state.active = state.slides.length - 1;
    renderAll();
  }

  function removeSlide(index) {
    if (state.slides.length <= 1) {
      log("warn", "至少保留一页幻灯片。");
      return;
    }
    state.slides.splice(index, 1);
    if (state.active >= state.slides.length) state.active = state.slides.length - 1;
    renderAll();
  }

  function deckPayload() {
    return {
      title: state.slides[0] ? state.slides[0].title : "24H-OS 演示",
      themeColor: state.themeColor.replace(/^#/, ""),
      slides: state.slides.map(function (slide) {
        return {
          title: slide.title,
          subtitle: slide.subtitle,
          bullets: slide.bullets
        };
      })
    };
  }

  function onExport() {
    var btn = document.getElementById("export-btn");
    btn.disabled = true;
    btn.textContent = "生成中…";
    log("send", "runTool('ppt.export') 开始");
    rpc("runTool", { tool: "ppt.export", deck: deckPayload() })
      .then(function (result) {
        log("ok", "已生成 PPTX：" + (result && result.path ? result.path : "(路径未知)"));
        showToast("已生成：" + (result && result.path ? result.path : ""), "ok");
      })
      .catch(function (error) {
        showToast("生成失败：" + error.message, "error");
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "生成 PPTX";
      });
  }

  function onModel() {
    var slide = activeSlide();
    var text = [slide.title, slide.subtitle].concat(slide.bullets || []).join("；");
    var btn = document.getElementById("model-btn");
    btn.disabled = true;
    log("send", "callModel() 开始");
    rpc("callModel", { prompt: "帮我把这段文字精简成 3 条要点：" + text })
      .then(function (result) {
        log("ok", "模型返回：" + (result && result.text ? result.text : ""));
        showToast("模型（桩）：" + (result && result.text ? result.text : ""), "ok");
      })
      .catch(function (error) {
        showToast("调用失败：" + error.message, "error");
      })
      .finally(function () {
        btn.disabled = false;
      });
  }

  function showToast(message, kind) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var toast = document.createElement("div");
    toast.className = "toast toast-" + (kind || "ok");
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 4200);
  }

  function renderAll() {
    renderTemplates();
    renderSlideList();
    renderEditor();
    renderPreview();
  }

  /* ------------------------------ 绑定 -------------------------------- */

  function bind() {
    document.getElementById("add-slide").addEventListener("click", addSlide);
    document.getElementById("export-btn").addEventListener("click", onExport);
    document.getElementById("model-btn").addEventListener("click", onModel);
    document.getElementById("clear-log").addEventListener("click", function () {
      document.getElementById("log").innerHTML = "";
    });
    document.getElementById("theme-color").addEventListener("input", function (event) {
      state.themeColor = event.target.value;
      renderTemplates();
      renderPreview();
    });
  }

  bind();
  renderAll();
  log("info", "UI 已加载，等待宿主握手…");
})();
