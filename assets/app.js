/* 00037《美学》闪卡 —— 纯静态、无依赖 */
(function () {
  "use strict";

  var DATA = window.MEIXUE_DATA;
  if (!DATA || !DATA.cards) return;

  var CARDS = DATA.cards;
  var CHAPTERS = DATA.meta.chapters || [];
  var KEY = "meixue-00037-v1";
  var SESSION_SIZE = 30;

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------ 本地存储 */
  var store = {
    v: 1,
    cards: {},
    prefs: { theme: null, order: "seq" },
    stats: { day: "", n: 0 }
  };

  function loadStore() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;
      store.cards = saved.cards && typeof saved.cards === "object" ? saved.cards : {};
      store.prefs = Object.assign(store.prefs, saved.prefs || {});
      store.stats = Object.assign(store.stats, saved.stats || {});
    } catch (e) { /* 隐私模式 / 数据损坏：当作全新开始 */ }
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* 忽略 */ }
    }, 120);
  }

  /* ------------------------------------------------ 日期 */
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function dateStr(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function today() { return dateStr(new Date()); }
  function plusDays(iso, n) {
    var d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  /* ------------------------------------------------ 全文（把答案填回去，用于搜索与摘要） */
  var FILL = CARDS.map(function (c) {
    var box = document.createElement("div");
    box.innerHTML = c.body || "";
    var blanks = box.querySelectorAll(".blk");
    for (var i = 0; i < blanks.length; i++) {
      var idx = parseInt(blanks[i].getAttribute("data-a"), 10);
      var ans = document.createElement("span");
      ans.innerHTML = (c.a && c.a[idx]) || "";
      blanks[i].parentNode.replaceChild(document.createTextNode(ans.textContent), blanks[i]);
    }
    return box.textContent.replace(/\s+/g, " ").trim();
  });

  var SEARCH = CARDS.map(function (c, i) {
    return (FILL[i] + " " + c.ch + " " + c.sec).toLowerCase();
  });

  /* ------------------------------------------------ 状态 */
  var state = {
    queue: [],
    pos: 0,
    scope: "今日",
    revealed: false,
    againCount: 0,
    startedAt: 0
  };

  /* ------------------------------------------------ 队列 */
  function isLearned(id) {
    var st = store.cards[id];
    return !!(st && st.reps > 0);
  }
  function isMastered(id) {
    var st = store.cards[id];
    return !!(st && st.reps >= 2);
  }
  function dueIndexes() {
    var t = today();
    var out = [];
    for (var i = 0; i < CARDS.length; i++) {
      var st = store.cards[CARDS[i].id];
      if (!st || !st.due || st.due <= t) out.push(i);
    }
    out.sort(function (a, b) {
      var da = (store.cards[CARDS[a].id] || {}).due || "0000";
      var db = (store.cards[CARDS[b].id] || {}).due || "0000";
      return da === db ? a - b : (da < db ? -1 : 1);
    });
    return out;
  }
  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }
  function applyOrder(list) {
    if (store.prefs.order === "shuffle") return shuffle(list);
    return list;
  }

  function cardsOfChapter(chIndex) {
    var out = [];
    for (var i = 0; i < CARDS.length; i++) if (CARDS[i].c === chIndex) out.push(i);
    return out;
  }
  function cardsOfSection(chIndex, sec) {
    var out = [];
    for (var i = 0; i < CARDS.length; i++) {
      if (CARDS[i].c === chIndex && CARDS[i].sec === sec) out.push(i);
    }
    return out;
  }

  /* ------------------------------------------------ 视图 */
  function showStudy() {
    $("study").hidden = false;
    $("done").hidden = true;
  }
  function showDone(custom) {
    $("study").hidden = true;
    $("done").hidden = false;
    $("progressFill").style.width = "100%";
    $("counter").textContent = "完成";

    var title = $("doneTitle");
    var text = $("doneText");
    if (custom) {
      title.textContent = custom.title;
      text.innerHTML = custom.text;
      $("againBtn").hidden = !!custom.hideAgain;
      return;
    }
    var left = dueIndexes().length;
    title.textContent = "这一轮学完了";
    var bits = ["本轮 " + state.queue.length + " 张卡片"];
    if (state.againCount) bits.push("「忘记」" + state.againCount + " 次");
    bits.push(left ? "今天还有 " + left + " 张待复习" : "今天的复习都安排好了");
    text.textContent = bits.join(" · ") + "。";
    $("againBtn").hidden = false;
    $("againBtn").textContent = left ? "继续下一轮" : "随便再刷一轮";
  }

  function render() {
    if (!state.queue.length) {
      showDone({
        title: "今天没有待复习的卡片",
        text: "所有卡片都在复习周期里。<br>想加练的话，可以去「目录」里挑一章。",
        hideAgain: true
      });
      return;
    }
    if (state.pos >= state.queue.length) {
      showDone();
      return;
    }

    showStudy();
    state.revealed = false;

    var idx = state.queue[state.pos];
    var card = CARDS[idx];

    $("crumbs").innerHTML =
      (card.ch ? '<span class="ch">' + esc(card.ch) + "</span>" : "") +
      (card.ch && card.sec ? '<span class="sep">·</span>' : "") +
      (card.sec ? '<span class="sec">' + esc(card.sec) + "</span>" : "");

    var body = $("cardBody");
    body.innerHTML = card.body;
    body.scrollTop = 0;

    var blanks = body.querySelectorAll(".blk");
    for (var i = 0; i < blanks.length; i++) {
      blanks[i].tabIndex = 0;
      blanks[i].setAttribute("role", "button");
      blanks[i].setAttribute("aria-label", "空位，点击揭示（" + (i + 1) + "/" + blanks.length + "）");
    }

    $("counter").textContent = (state.pos + 1) + " / " + state.queue.length;
    $("progressFill").style.width = (state.pos / state.queue.length * 100) + "%";
    $("revealBtn").hidden = false;
    $("grades").hidden = true;
    $("hint").innerHTML = blanks.length > 1
      ? "共 " + blanks.length + " 个空位：点空位逐个揭示，<kbd>空格</kbd> 一次看全。"
      : "点击空位或按 <kbd>空格</kbd> 看答案。";

    if (state.pos > 0) window.scrollTo({ top: 0, behavior: "auto" });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  function revealBlank(el, card) {
    var i = parseInt(el.getAttribute("data-a"), 10);
    if (isNaN(i)) return;
    el.innerHTML = card.a[i] != null ? card.a[i] : "";
    el.classList.add("on");
    el.removeAttribute("role");
    el.removeAttribute("tabindex");
  }

  function revealAll() {
    if (state.pos >= state.queue.length) return;
    var card = CARDS[state.queue[state.pos]];
    var blanks = $("cardBody").querySelectorAll(".blk:not(.on)");
    for (var i = 0; i < blanks.length; i++) revealBlank(blanks[i], card);
    state.revealed = true;
    $("revealBtn").hidden = true;
    $("grades").hidden = false;
    $("hint").innerHTML = "想起来了就「记住」；没想起来点「忘记」，这张稍后会再出现。";
  }

  /* ------------------------------------------------ 评分 */
  function grade(g) {
    if (state.pos >= state.queue.length) return;
    var idx = state.queue[state.pos];
    var card = CARDS[idx];
    var t = today();
    var st = store.cards[card.id];
    if (!st) {
      st = store.cards[card.id] = { iv: 0, due: "", reps: 0, lapses: 0 };
    }

    if (g === "again") {
      st.iv = 0;
      st.reps = 0;
      st.lapses = (st.lapses || 0) + 1;
      st.due = t;
      state.againCount++;
    } else if (g === "hard") {
      st.iv = st.iv ? Math.max(1, Math.round(st.iv * 1.5)) : 1;
      st.reps = (st.reps || 0) + 1;
      st.due = plusDays(t, st.iv);
    } else {
      st.iv = st.iv ? Math.min(365, Math.round(st.iv * 2.3)) : 1;
      st.reps = (st.reps || 0) + 1;
      st.due = plusDays(t, st.iv);
    }
    st.seen = (st.seen || 0) + 1;

    if (store.stats.day !== t) {
      store.stats.day = t;
      store.stats.n = 0;
    }
    store.stats.n++;
    save();

    if (g === "again") {
      var at = Math.min(state.queue.length, state.pos + 4);
      state.queue.splice(at, 0, idx);
    }
    state.pos++;
    render();
    refreshStats();
  }

  /* ------------------------------------------------ 开始一轮 */
  function start(list, scope, at) {
    if (!list.length) {
      state.queue = [];
      state.pos = 0;
      showDone({
        title: "今天没有待复习的卡片",
        text: "所有卡片都在复习周期里。<br>想加练的话，可以去「目录」里挑一章。",
        hideAgain: true
      });
      return;
    }
    state.queue = applyOrder(list.slice());
    state.pos = at || 0;
    state.scope = scope || "";
    state.revealed = false;
    state.againCount = 0;
    state.startedAt = Date.now();
    render();
    refreshStats();
  }

  function startToday() {
    start(dueIndexes().slice(0, SESSION_SIZE), "今日");
  }

  /* ------------------------------------------------ 目录 */
  function sectionList() {
    var map = {};
    var order = [];
    for (var i = 0; i < CARDS.length; i++) {
      var c = CARDS[i];
      var k = c.c + "\u0000" + c.sec;
      if (!map[k]) { map[k] = { ch: c.c, sec: c.sec, total: 0, done: 0, ids: [] }; order.push(k); }
      map[k].total++;
      map[k].ids.push(i);
      if (isMastered(c.id)) map[k].done++;
    }
    return order.map(function (k) { return map[k]; });
  }

  function renderToc() {
    var toc = $("toc");
    toc.innerHTML = "";
    var secs = sectionList();
    var frag = document.createDocumentFragment();

    CHAPTERS.forEach(function (name, ci) {
      var total = 0, done = 0, i;
      for (i = 0; i < CARDS.length; i++) {
        if (CARDS[i].c === ci) {
          total++;
          if (isMastered(CARDS[i].id)) done++;
        }
      }
      if (!total) return;

      var chBtn = document.createElement("button");
      chBtn.type = "button";
      chBtn.className = "toc-ch";
      chBtn.innerHTML = "<span>" + esc(name) + '</span><span class="n">' +
        (done ? done + " / " : "") + total + "</span>";
      chBtn.addEventListener("click", function () {
        closeMenu();
        start(cardsOfChapter(ci), name);
      });
      frag.appendChild(chBtn);

      secs.filter(function (s) { return s.ch === ci; }).forEach(function (s) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "toc-sec";
        b.innerHTML = "<span>" + esc(s.sec || "未分节") + '</span><span class="n">' +
          (s.done ? s.done + " / " : "") + s.total + "</span>";
        b.addEventListener("click", function () {
          closeMenu();
          start(cardsOfSection(ci, s.sec), s.sec || name);
        });
        frag.appendChild(b);
      });
    });

    if (!CHAPTERS.length) {
      var all = document.createElement("button");
      all.type = "button";
      all.className = "toc-sec";
      all.innerHTML = "<span>全部卡片</span><span class=\"n\">" + CARDS.length + "</span>";
      all.addEventListener("click", function () { closeMenu(); start(CARDS.map(function (_, i) { return i; }), "全部"); });
      frag.appendChild(all);
    }

    toc.appendChild(frag);
  }

  function refreshStats() {
    var due = dueIndexes().length;
    var all = CARDS.length;
    var mastered = 0;
    for (var i = 0; i < all; i++) if (isMastered(CARDS[i].id)) mastered++;
    if (store.stats.day !== today()) store.stats.n = 0;

    $("dueCount").textContent = due ? due : "0";
    $("allCount").textContent = all;
    $("footStats").innerHTML =
      "已掌握 " + mastered + " / " + all +
      "　·　今日已复习 " + (store.stats.n || 0) + " 张";

    $("brandSub").textContent = DATA.meta.count + " 张卡 · " + DATA.meta.blanks + " 个空位";
  }

  /* ------------------------------------------------ 搜索 */
  var searchTimer = null;
  function doSearch() {
    var q = $("searchInput").value.trim();
    var results = $("results");
    var toc = $("toc");
    var quick = $("quick");

    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      toc.hidden = false;
      quick.hidden = false;
      return;
    }

    toc.hidden = true;
    quick.hidden = true;
    results.hidden = false;

    var lq = q.toLowerCase();
    var hits = [];
    for (var i = 0; i < CARDS.length && hits.length < 60; i++) {
      if (SEARCH[i].indexOf(lq) !== -1) hits.push(i);
    }

    var html = '<div class="res-head">' + (hits.length ? "找到 " + hits.length + " 张 · 点任意一张开始" : "") + "</div>";
    if (!hits.length) {
      html = '<div class="res-empty">没有找到「' + esc(q) + "」</div>";
      results.innerHTML = html;
      return;
    }

    hits.forEach(function (i, n) {
      var c = CARDS[i];
      html += '<button type="button" class="res-item" data-i="' + n + '">' +
        '<span class="where">' + esc(c.ch) + (c.sec ? " · " + esc(c.sec) : "") + "</span>" +
        '<span class="snippet">' + esc(snippet(i, q)) + "</span></button>";
    });
    results.innerHTML = html;

    Array.prototype.forEach.call(results.querySelectorAll(".res-item"), function (el) {
      el.addEventListener("click", function () {
        var n = parseInt(el.getAttribute("data-i"), 10);
        closeMenu();
        start(hits, "搜索「" + q + "」", n);
      });
    });
  }

  function snippet(index, q) {
    var text = FILL[index] || "";
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    var start = i > 22 ? i - 22 : 0;
    var cut = text.slice(start, start + 54);
    return (start > 0 ? "…" : "") + cut + (text.length > start + 54 ? "…" : "");
  }

  /* ------------------------------------------------ 抽屉 / 主题 */
  function openMenu() {
    $("drawer").classList.add("is-open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("menuBtn").setAttribute("aria-expanded", "true");
    $("mask").hidden = false;
    requestAnimationFrame(function () { $("mask").classList.add("is-on"); });
    document.body.style.overflow = "hidden";
    setTimeout(function () { $("searchInput").focus({ preventScroll: true }); }, 320);
  }

  function closeMenu() {
    $("drawer").classList.remove("is-open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("menuBtn").setAttribute("aria-expanded", "false");
    $("mask").classList.remove("is-on");
    document.body.style.overflow = "";
    setTimeout(function () { $("mask").hidden = true; }, 300);
  }

  function menuOpen() { return $("drawer").classList.contains("is-open"); }

  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "dark" ? "#161512" : "#f6f3ec");
  }

  function setOrderUI() {
    Array.prototype.forEach.call($("orderSeg").querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-order") === store.prefs.order);
    });
  }

  /* ------------------------------------------------ 事件绑定 */
  function bind() {
    $("revealBtn").addEventListener("click", revealAll);

    $("grades").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-g]");
      if (b) grade(b.getAttribute("data-g"));
    });

    $("cardBody").addEventListener("click", function (e) {
      var blk = e.target.closest(".blk");
      if (!blk || blk.classList.contains("on")) return;
      var card = CARDS[state.queue[state.pos]];
      if (!card) return;
      revealBlank(blk, card);
      // 只要点开一个空位，就把评分按钮亮出来（允许自评）
      $("revealBtn").hidden = true;
      $("grades").hidden = false;
      state.revealed = true;
    });

    $("cardBody").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var blk = e.target.closest(".blk");
      if (!blk || blk.classList.contains("on")) return;
      e.preventDefault();
      e.stopPropagation();
      var card = CARDS[state.queue[state.pos]];
      if (!card) return;
      revealBlank(blk, card);
      $("revealBtn").hidden = true;
      $("grades").hidden = false;
      state.revealed = true;
    });

    $("againBtn").addEventListener("click", startToday);
    $("openMenuBtn").addEventListener("click", openMenu);

    $("menuBtn").addEventListener("click", function () {
      if (menuOpen()) closeMenu(); else openMenu();
    });
    $("closeMenuBtn").addEventListener("click", closeMenu);
    $("mask").addEventListener("click", closeMenu);

    $("searchInput").addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 90);
    });

    $("quick").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-scope]");
      if (!b) return;
      closeMenu();
      if (b.getAttribute("data-scope") === "today") start(dueIndexes().slice(0, SESSION_SIZE), "今日");
      else start(CARDS.map(function (_, i) { return i; }), "全部");
    });

    $("orderSeg").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-order]");
      if (!b) return;
      store.prefs.order = b.getAttribute("data-order");
      save();
      setOrderUI();
    });

    $("resetBtn").addEventListener("click", function () {
      if (!window.confirm("清空这台设备上的复习进度？此操作不可撤销。")) return;
      store.cards = {};
      store.stats = { day: "", n: 0 };
      save();
      refreshStats();
      renderToc();
      closeMenu();
      startToday();
    });

    $("themeBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setTheme(next);
      store.prefs.theme = next;
      save();
    });

    window.addEventListener("scroll", function () {
      document.body.classList.toggle("is-scrolled", window.scrollY > 8);
    }, { passive: true });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (menuOpen()) { e.preventDefault(); closeMenu(); }
        return;
      }
      if (e.target instanceof Element && e.target.matches("input, textarea, select")) return;
      if (menuOpen()) return;
      if (e.key === "/") {
        e.preventDefault();
        openMenu();
        return;
      }
      if (!$("done").hidden) {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!$("againBtn").hidden) startToday(); }
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!$("grades").hidden) grade("good");
        else revealAll();
        return;
      }
      if ($("grades").hidden) return;
      if (e.key === "1") { e.preventDefault(); grade("again"); }
      else if (e.key === "2") { e.preventDefault(); grade("hard"); }
      else if (e.key === "3") { e.preventDefault(); grade("good"); }
    });
  }

  /* ------------------------------------------------ 启动 */
  loadStore();
  var qTheme = (location.search.match(/[?&]theme=(light|dark)/) || [])[1];
  if (qTheme) store.prefs.theme = qTheme;
  if (store.prefs.theme) setTheme(store.prefs.theme);
  setOrderUI();
  bind();
  renderToc();
  refreshStats();
  startToday();
})();
