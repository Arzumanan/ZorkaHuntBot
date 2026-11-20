/* Вкладка «Журнал»: записи, форма добавления, удаление, статистика (только если записи есть). */
(function () {
  "use strict";
  const { h, fmtDate, state, view } = Z;
  const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  function monthLabel(ym) { const [y, m] = ym.split("-"); return MONTHS[Number(m) - 1] + " " + y; }

  function barList(rows, limit) {
    const max = Math.max(...rows.map((r) => r.count), 1);
    return rows.slice(0, limit || 7).map((r) => h("div", { class: "stat-row" },
      h("div", { class: "kv" }, h("span", { class: "stat-name" }, r.name), h("b", {}, r.count)),
      h("div", { class: "bar" }, h("div", { style: `width:${(r.count / max) * 100}%;background:var(--btn)` }))));
  }

  function statsCard(st) {
    return h("div", { class: "card" },
      h("h3", {}, "📊 Статистика"),
      h("div", { class: "row stat-top" },
        h("div", {}, h("div", { class: "big-num" }, st.records), h("div", { class: "muted" }, "записей")),
        h("div", {}, h("div", { class: "big-num" }, st.trips), h("div", { class: "muted" }, "выездов"))),
      st.by_species.length ? h("div", {}, h("h4", {}, "По дичи"), barList(st.by_species)) : null,
      st.by_place.length ? h("div", {}, h("h4", {}, "По угодьям"), barList(st.by_place)) : null,
      st.by_month.length ? h("div", {}, h("h4", {}, "По месяцам"),
        barList(st.by_month.slice(-12).map((m) => ({ name: monthLabel(m.month), count: m.count })), 12)) : null,
      st.best_months.length ? h("div", {}, h("h4", {}, "Лучшие месяцы"),
        h("div", {}, st.best_months.map((m) => h("span", { class: "tag" }, `${m.name}: ${m.count}`)))) : null);
  }

  function draw(journal, stats) {
    const records = journal.records;
    const placeNames = [...new Set([...(state.me ? state.me.places.map((p) => p.name) : []), ...records.map((r) => r.place)])];
    const speciesNames = [...new Set(records.map((r) => r.species))];

    const date = h("input", { type: "date", value: Z.todayISO(), max: Z.todayISO() });
    const place = h("input", { type: "text", list: "dl-places", maxlength: "200", placeholder: "Где охотились", autocomplete: "off" });
    const species = h("input", { type: "text", list: "dl-species", maxlength: "100", placeholder: "Дичь / зверь (кряква, кабан…)", autocomplete: "off" });
    const note = h("textarea", { maxlength: "500", rows: "3", placeholder: "Заметка (необязательно)" });
    const msg = h("div", { class: "error" });
    const form = h("div", { class: "card hidden" },
      h("h3", {}, "Новая запись"),
      h("label", { class: "field" }, h("span", { class: "muted" }, "Дата"), date),
      h("label", { class: "field" }, h("span", { class: "muted" }, "Угодье"), place),
      h("label", { class: "field" }, h("span", { class: "muted" }, "Дичь"), species),
      h("label", { class: "field" }, h("span", { class: "muted" }, "Заметка"), note),
      msg,
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: save }, "Сохранить"),
        h("button", { class: "btn secondary", onclick: () => form.classList.add("hidden") }, "Отмена")),
      h("datalist", { id: "dl-places" }, placeNames.map((n) => h("option", { value: n }))),
      h("datalist", { id: "dl-species" }, speciesNames.map((n) => h("option", { value: n }))));

    async function save() {
      msg.textContent = "";
      try {
        await Z.post("/journal", { date: date.value, place: place.value, species: species.value, note: note.value });
        Z.haptic.ok();
        Z.toast("Записано в журнал ✅");
        Z.go("journal");
      } catch (e) { msg.textContent = e.message; Z.haptic.error(); }
    }

    async function remove(rec) {
      if (!(await Z.confirm(`Удалить запись «${rec.species}», ${fmtDate(rec.date)}?`))) return;
      try { await Z.post("/journal/delete", { id: rec.id }); Z.haptic.tap(); Z.go("journal"); }
      catch (e) { Z.toast(e.message, true); }
    }

    const list = records.length
      ? records.map((r) => h("div", { class: "card rec" },
        h("div", { class: "card-head" },
          h("div", {}, h("b", {}, r.species), h("div", { class: "muted" }, fmtDate(r.date) + " · " + r.place)),
          h("button", { class: "icon-btn del", "aria-label": "Удалить запись", onclick: () => remove(r) }, "🗑")),
        r.note ? h("div", { class: "rec-note" }, r.note) : null))
      : [h("div", { class: "empty" }, "Журнал пока пуст. Он ведётся по желанию — добавьте первую запись, и здесь появится статистика.")];

    Z.render(
      h("button", { class: "btn wide", onclick: () => { form.classList.toggle("hidden"); if (!form.classList.contains("hidden")) place.focus(); } }, "＋ Добавить запись"),
      form,
      stats && stats.records > 0 ? statsCard(stats) : null,
      h("h2", { class: "day-title" }, records.length ? `Записи (${records.length})` : "Записи"),
      list);
  }

  Z.views.journal = async function renderJournal() {
    const journal = await Z.api("/journal");
    const stats = journal.stats;      // статистика приходит вместе с журналом и только если записи есть
    if (state.tab !== "journal") return;
    draw(journal, stats);
  };
})();
