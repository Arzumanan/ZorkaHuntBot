/* Вкладка «Сезоны»: сроки охоты в регионе пользователя. */
(function () {
  "use strict";
  const { h, fmtDate, state, view } = Z;
  const STATE_LABEL = { open: "открыт", upcoming: "скоро", closed: "закрыт", banned: "нет" };

  function entryNode(e) {
    let when = "";
    if (e.state === "open") when = "до " + fmtDate(e.current_end);
    else if (e.state === "upcoming") when = `откроется ${fmtDate(e.next_start)} (через ${e.days_to_open} дн.)`;
    else if (e.state === "closed" && e.next_start) when = "следующий — с " + fmtDate(e.next_start);
    const ranges = e.windows.map((w) => `${fmtDate(w.start)} — ${fmtDate(w.end)}`).join("; ");
    return h("div", { class: "entry" },
      h("div", {}, h("span", { class: "chip " + e.state }, e.frame ? "рамки" : STATE_LABEL[e.state]), " ", h("span", { class: "name" }, e.name)),
      when && h("div", {}, when),
      ranges && h("div", { class: "muted" }, ranges),
      e.confidence === "regional_reported" && h("div", { class: "muted" }, "⚠️ по сообщениям, проверьте"),
      e.note && h("div", { class: "muted" }, e.note));
  }

  function draw(data) {
    const links = data.sources.map((src) => h("li", {}, h("a", { href: src.url, onclick: (ev) => Z.openLink(ev, src.url) }, src.title)));
    Z.render(
      h("div", { class: "card notice" + (data.verified ? " ok" : "") },
        h("b", {}, data.region.name), h("div", { class: "muted" }, "Сегодня " + fmtDate(data.today) + " · открыто сейчас: " + data.open_count),
        h("div", {}, data.verified ? data.summary : "Для этого региона нет проверенных региональных дат: показаны федеральные сроки (приказ Минприроды № 477)."),
        h("div", { class: "muted", style: "margin-top:6px" }, "⚠️ " + data.disclaimer),
        h("button", { class: "btn secondary", style: "margin-top:8px", onclick: () => Z.askRegion(() => Z.go("seasons")) }, "Сменить регион")),
      data.categories.filter((c) => c.entries.length).map((c) => h("div", { class: "card" }, h("h3", {}, c.title), c.entries.map(entryNode))),
      data.notes && h("div", { class: "card" }, "ℹ️ " + data.notes),
      h("div", { class: "card" }, h("h3", {}, "Источники"), h("ul", { class: "plain" }, links),
        h("div", { class: "muted" }, "Это справка, а не юридический документ.")));
  }

  Z.views.seasons = async function renderSeasons() {
    try {
      const data = await Z.api("/api/seasons");
      if (state.tab !== "seasons") return;
      draw(data);
    } catch (e) {
      if (state.tab !== "seasons") return;
      if (e.code === "no_region") return Z.askRegion(() => Z.go("seasons"));
      throw e;
    }
  };
})();
