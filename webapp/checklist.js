/* Вкладка «Чек-лист»: вид охоты, категории, отметки (в хранилище Telegram), свои пункты, сброс, подсказки по погоде. */
(function () {
  "use strict";
  const { h, state, view } = Z;
  let currentHints = [];      // подсказки по погоде подгружаются отдельно, чтобы чек-лист открывался без ожидания сети

  function progress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { pct, color: done === total && total ? "var(--ok)" : "var(--btn)" };
  }

  function draw(data) {
    const refs = { cats: {} };
    const topCount = h("b", {});
    const topBar = h("div", { style: "height:100%;border-radius:4px;transition:width .2s" });
    const resetBtn = h("button", { class: "btn secondary", onclick: doReset }, "♻️ Сбросить отметки");

    function recount() {
      let done = 0, total = 0;
      for (const c of data.categories) {
        const d = c.items.filter((i) => i.checked).length;
        c.done = d; c.total = c.items.length;
        done += d; total += c.total;
        refs.cats[c.code].count.textContent = `${d}/${c.total}`;
      }
      data.done = done; data.total = total;
      const p = progress(done, total);
      topCount.textContent = `Собрано ${done} из ${total}`;
      topBar.style.width = p.pct + "%";
      topBar.style.background = p.color;
      resetBtn.classList.toggle("hidden", done === 0);
    }

    async function doReset() {
      if (!(await Z.confirm("Снять все отметки в этом чек-листе? Свои пункты останутся."))) return;
      try {
        const next = await Z.post("/checklist/reset");
        Z.haptic.ok();
        Z.toast("Отметки сброшены");
        draw(next);
      } catch (e) { Z.toast(e.message, true); }
    }

    async function toggle(item, row, box) {
      const was = item.checked;
      item.checked = !was;                    // оптимистично, откатим при ошибке
      row.classList.toggle("done", item.checked);
      box.checked = item.checked;
      Z.haptic.select();
      recount();
      try {
        const res = await Z.post("/checklist/toggle", { id: item.id });
        if (res.checked !== item.checked) { item.checked = res.checked; row.classList.toggle("done", res.checked); box.checked = res.checked; recount(); }
      } catch (e) {
        item.checked = was; row.classList.toggle("done", was); box.checked = was; recount();
        Z.toast(e.message, true);
      }
    }

    async function removeItem(cat, item, row) {
      if (!(await Z.confirm(`Удалить свой пункт «${item.text}»?`))) return;
      try {
        await Z.post("/checklist/delete", { id: item.id });
        cat.items = cat.items.filter((i) => i.id !== item.id);
        row.remove();
        Z.haptic.tap();
        recount();
      } catch (e) { Z.toast(e.message, true); }
    }

    function itemRow(cat, item) {
      const box = h("input", { type: "checkbox", checked: item.checked, "aria-label": item.text });
      const row = h("label", { class: "check-row" + (item.checked ? " done" : "") },
        box, h("span", { class: "check-text" }, item.text));
      box.addEventListener("change", () => toggle(item, row, box));
      if (!item.custom) return row;
      const del = h("button", { class: "icon-btn del", "aria-label": "Удалить пункт", onclick: (ev) => { ev.preventDefault(); removeItem(cat, item, wrap); } }, "✕");
      const wrap = h("div", { class: "check-wrap" }, row, del);
      return wrap;
    }

    function categoryCard(cat) {
      const list = h("div", {}, cat.items.map((i) => itemRow(cat, i)));
      const count = h("span", { class: "muted" });
      refs.cats[cat.code] = { count, list };
      const input = h("input", { type: "text", maxlength: "100", placeholder: "Свой пункт…", autocomplete: "off" });
      const add = async () => {
        const text = input.value.trim();
        if (!text) return;
        try {
          const res = await Z.post("/checklist/add", { category: cat.code, text });
          cat.items.push(res.item);
          list.append(itemRow(cat, res.item));
          input.value = "";
          Z.haptic.ok();
          recount();
        } catch (e) { Z.toast(e.message, true); }
      };
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
      return h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h3", {}, cat.name), count),
        list,
        h("div", { class: "add-row" }, input, h("button", { class: "btn", onclick: add, "aria-label": "Добавить пункт" }, "＋")));
    }

    const types = h("div", { class: "chips" }, data.hunt_types.map((t) =>
      h("button", { class: "chipbtn" + (t.code === data.hunt_type ? " active" : ""), onclick: () => switchType(t.code) }, t.name)));

    async function switchType(code) {
      if (code === data.hunt_type) return;
      Z.haptic.select();
      try {
        const next = await Z.post("/checklist/type", { hunt_type: code });
        draw(next);
      } catch (e) { Z.toast(e.message, true); }
    }

    Z.render(
      h("div", { class: "card" },
        h("h3", {}, "🎒 Чек-лист снаряжения"),
        h("div", { class: "muted" }, "Вид охоты:"), types,
        h("div", { style: "margin-top:10px" }, topCount),
        h("div", { class: "bar big" }, topBar)),
      hintsCard(currentHints),
      data.categories.map(categoryCard),
      h("div", { style: "text-align:center;margin:8px 0" }, resetBtn),
      state.me && !state.me.has_place
        ? h("div", { class: "muted", style: "text-align:center" }, "Подсказки по погоде появятся, когда вы добавите угодье или место (вкладка «Ещё»).")
        : null);
    recount();
  }

  function hintsCard(hints) {
    return h("div", { class: "card notice" + (hints.length ? "" : " hidden"), id: "hints-box" },
      h("h3", {}, "Подсказки по погоде"), hints.map((t) => h("div", { class: "hint" }, t)));
  }

  Z.views.checklist = async function renderChecklist() {
    currentHints = [];
    const data = await Z.api("/checklist");
    if (state.tab !== "checklist") return;
    draw(data);
    Z.api("/checklist/hints").then((res) => {           // погода нужна только для подсказок, поэтому не блокирует экран
      currentHints = res.hints || [];
      const box = document.getElementById("hints-box");
      if (state.tab === "checklist" && box) box.replaceWith(hintsCard(currentHints));
    }).catch(() => { /* без подсказок */ });
  };
})();
