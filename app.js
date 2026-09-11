(function () {
  "use strict";

  var STORAGE_KEY = "gospelPartners.v1";
  var SETTINGS_KEY = "gospelPartners.settings.v1";
  var DAY_MS = 24 * 60 * 60 * 1000;
  var DEFAULT_MONTH_RANGE = 3;

  /** @type {Array<Object>} */
  var partners = [];
  var settings = { monthRange: DEFAULT_MONTH_RANGE };
  var pendingGivingTargetId = null; // id awaiting an amount from the giving modal
  var pendingGivingIsNewPartner = false;

  // ---------- persistence ----------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      partners = raw ? JSON.parse(raw) : [];
    } catch (e) {
      partners = [];
    }
    try {
      var rawSettings = localStorage.getItem(SETTINGS_KEY);
      if (rawSettings) {
        var parsed = JSON.parse(rawSettings);
        if (parsed && [1, 2, 3].indexOf(parsed.monthRange) !== -1) {
          settings.monthRange = parsed.monthRange;
        }
      }
    } catch (e) {
      // keep default
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(partners));
    } catch (e) {
      // storage unavailable; app still works for the session
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // storage unavailable; app still works for the session
    }
  }

  // ---------- date helpers ----------
  function todayAtMidnight() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function parseISODate(s) {
    if (!s) return null;
    var parts = s.split("-");
    return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  }

  function formatDisplayDate(s) {
    var d = parseISODate(s);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function formatMoney(n) {
    var num = Number(n) || 0;
    return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- scheduling ----------
  // The end of the selected month range: e.g. a range of 2 starting in September
  // ends on October 31 (the last day of the second month in the range).
  function endOfMonthRange(monthRange, fromDate) {
    var y = fromDate.getFullYear();
    var m = fromDate.getMonth();
    return new Date(y, m + monthRange, 0);
  }

  function currentWindowDays() {
    var today = todayAtMidnight();
    var end = endOfMonthRange(settings.monthRange, today);
    var days = Math.round((end.getTime() - today.getTime()) / DAY_MS);
    return Math.max(1, days);
  }

  // Evenly distribute unprayed partners' next prayer date across the configured
  // month-range window, in the order they were added. Prayed partners keep the
  // fixed date they were prayed on, until a new cycle begins.
  function recomputeSchedule() {
    var unprayed = partners.filter(function (p) { return !p.prayed; });
    var n = unprayed.length;
    if (n === 0) return;
    var today = todayAtMidnight();
    var windowDays = currentWindowDays();

    unprayed.forEach(function (p, i) {
      var offsetDays = Math.round(((i + 0.5) * windowDays) / n);
      offsetDays = Math.max(1, offsetDays);
      var d = new Date(today.getTime() + offsetDays * DAY_MS);
      p.scheduled = toISODate(d);
    });
  }

  // Starts a new prayer cycle: clears every "prayed" mark and redistributes every
  // partner's scheduled date evenly from today through the end of the selected
  // month range.
  function startNewCycle(monthRange) {
    settings.monthRange = monthRange;
    saveSettings();
    partners.forEach(function (p) { p.prayed = false; });
    recomputeSchedule();
    save();
    render();
  }

  function scheduleColorClass(partner) {
    if (partner.prayed) return "date-normal";
    var sched = parseISODate(partner.scheduled);
    if (!sched) return "date-normal";
    var today = todayAtMidnight();
    var diffDays = Math.round((sched.getTime() - today.getTime()) / DAY_MS);
    if (diffDays < 0) return "date-past";
    if (diffDays <= 3) return "date-soon";
    return "date-normal";
  }

  // ---------- rendering ----------
  function render() {
    renderPartnersTable();
    renderGivingTable();
  }

  function renderPartnersTable() {
    var tbody = document.getElementById("partners-tbody");
    var emptyEl = document.getElementById("partners-empty");
    var wrapEl = document.getElementById("partners-table-wrap");
    tbody.innerHTML = "";

    if (partners.length === 0) {
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }
    wrapEl.style.display = "block";
    emptyEl.style.display = "none";

    partners.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.dataset.id = p.id;
      if (p.prayed) tr.classList.add("prayed");

      var dateClass = scheduleColorClass(p);

      tr.innerHTML =
        '<td class="name-cell"><strong>' + escapeHtml(p.name) + "</strong></td>" +
        '<td class="ministry-cell">' + escapeHtml(p.ministry) + "</td>" +
        "<td>" + formatDisplayDate(p.dateStarted) + "</td>" +
        '<td class="center"><input type="checkbox" class="checkbox giving-checkbox" data-action="toggle-giving" ' + (p.giving ? "checked" : "") + "></td>" +
        '<td class="' + dateClass + '">' + formatDisplayDate(p.scheduled) + "</td>" +
        '<td class="center"><input type="checkbox" class="checkbox" data-action="toggle-prayed" ' + (p.prayed ? "checked" : "") + "></td>" +
        '<td class="center"><button type="button" class="row-remove" data-action="remove" title="Remove partner" aria-label="Remove ' + escapeHtml(p.name) + '">&times;</button></td>';

      tbody.appendChild(tr);
    });
  }

  function renderGivingTable() {
    var tbody = document.getElementById("giving-tbody");
    var emptyEl = document.getElementById("giving-empty");
    var givers = partners.filter(function (p) { return p.giving; });

    tbody.innerHTML = "";

    if (givers.length === 0) {
      emptyEl.style.display = "block";
    } else {
      emptyEl.style.display = "none";
    }

    var total = 0;
    givers.forEach(function (p) {
      total += Number(p.givingAmount) || 0;
      var tr = document.createElement("tr");
      tr.dataset.id = p.id;
      tr.innerHTML =
        '<td class="name-cell"><strong>' + escapeHtml(p.name) + "</strong></td>" +
        '<td class="amount-cell editable" data-action="edit-giving">' + formatMoney(p.givingAmount) + "</td>" +
        '<td class="editable" data-action="edit-giving">' + formatDisplayDate(p.givingDate) + "</td>";
      tbody.appendChild(tr);
    });

    document.getElementById("giving-total").textContent = formatMoney(total);
    document.getElementById("giving-count").textContent = String(givers.length);
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---------- modals ----------
  function openModal(id) {
    document.getElementById(id).classList.add("active");
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove("active");
  }

  function openGivingModal(partner, isNew) {
    pendingGivingTargetId = partner.id;
    pendingGivingIsNewPartner = !!isNew;
    document.getElementById("giving-modal-title").textContent = "Record giving for " + partner.name;
    document.getElementById("g-amount").value = partner.givingAmount || "";
    document.getElementById("g-date").value = partner.givingDate || toISODate(todayAtMidnight());
    openModal("giving-modal");
    setTimeout(function () { document.getElementById("g-amount").focus(); }, 50);
  }

  // ---------- actions ----------
  function addPartner(data) {
    var p = {
      id: "p" + Date.now() + Math.floor(Math.random() * 1000),
      name: data.name,
      ministry: data.ministry,
      dateStarted: data.dateStarted,
      giving: false,
      givingAmount: 0,
      givingDate: null,
      prayed: false,
      scheduled: null
    };
    partners.push(p);
    recomputeSchedule();
    save();
    render();

    if (data.giving) {
      openGivingModal(p, true);
    }
  }

  function removePartner(id) {
    partners = partners.filter(function (p) { return p.id !== id; });
    recomputeSchedule();
    save();
    render();
  }

  function toggleGiving(id, checked) {
    var p = findPartner(id);
    if (!p) return;
    if (checked) {
      openGivingModal(p, false);
      // Revert checkbox visually until confirmed; if the user cancels, restore unchecked state.
    } else {
      p.giving = false;
      p.givingAmount = 0;
      p.givingDate = null;
      save();
      render();
    }
  }

  function togglePrayed(id, checked) {
    var p = findPartner(id);
    if (!p) return;
    p.prayed = checked;
    if (checked) {
      p.scheduled = toISODate(todayAtMidnight());
    }
    recomputeSchedule();
    save();
    render();
  }

  function findPartner(id) {
    for (var i = 0; i < partners.length; i++) {
      if (partners[i].id === id) return partners[i];
    }
    return null;
  }

  // ---------- events ----------
  function init() {
    load();
    // Only assign schedule dates on first run / for partners that don't have one yet.
    // Once a date is assigned it stays fixed until the roster changes (add, remove,
    // or a prayed toggle), so dates don't drift just from reopening the app.
    var needsSchedule = partners.some(function (p) { return !p.prayed && !p.scheduled; });
    if (needsSchedule) recomputeSchedule();
    save();
    document.getElementById("month-range").value = String(settings.monthRange);
    render();

    // tabs
    document.querySelectorAll("nav.tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("nav.tabs button").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var view = btn.dataset.view;
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        document.getElementById("view-" + view).classList.add("active");
      });
    });

    // month range preference (applied when "New cycle" is pressed)
    document.getElementById("month-range").addEventListener("change", function (e) {
      var val = parseInt(e.target.value, 10);
      if ([1, 2, 3].indexOf(val) === -1) return;
      settings.monthRange = val;
      saveSettings();
    });

    // new cycle button
    document.getElementById("new-cycle-btn").addEventListener("click", function () {
      var val = parseInt(document.getElementById("month-range").value, 10);
      if ([1, 2, 3].indexOf(val) === -1) val = settings.monthRange;
      var label = val === 1 ? "1 month" : val + " months";
      var proceed = confirm(
        "Start a new " + label + " prayer cycle?\n\nThis will unmark every partner as prayed for and spread everyone's scheduled dates from today to the end of the range."
      );
      if (!proceed) return;
      startNewCycle(val);
    });

    // fab
    document.getElementById("add-btn").addEventListener("click", function () {
      document.getElementById("add-form").reset();
      document.getElementById("f-started").value = toISODate(todayAtMidnight());
      openModal("add-modal");
      setTimeout(function () { document.getElementById("f-name").focus(); }, 50);
    });

    // modal close buttons / backdrop
    document.querySelectorAll("[data-close]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var modalId = btn.dataset.close;
        closeModal(modalId);
        if (modalId === "giving-modal") {
          // user cancelled recording an amount; ensure state reflects "not giving"
          var p = findPartner(pendingGivingTargetId);
          if (p && !p.giving) {
            render(); // restores checkbox to unchecked
          }
          pendingGivingTargetId = null;
        }
      });
    });
    document.querySelectorAll(".modal-backdrop").forEach(function (backdrop) {
      backdrop.addEventListener("click", function (e) {
        if (e.target === backdrop) {
          backdrop.classList.remove("active");
          if (backdrop.id === "giving-modal") {
            var p = findPartner(pendingGivingTargetId);
            if (p && !p.giving) render();
            pendingGivingTargetId = null;
          }
        }
      });
    });

    // add partner form
    document.getElementById("add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("f-name").value.trim();
      var ministry = document.getElementById("f-ministry").value.trim();
      var dateStarted = document.getElementById("f-started").value;
      var giving = document.getElementById("f-giving").checked;
      if (!name || !ministry || !dateStarted) return;
      closeModal("add-modal");
      addPartner({ name: name, ministry: ministry, dateStarted: dateStarted, giving: giving });
    });

    // giving amount form
    document.getElementById("giving-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var p = findPartner(pendingGivingTargetId);
      if (!p) { closeModal("giving-modal"); return; }
      var amount = parseFloat(document.getElementById("g-amount").value);
      var date = document.getElementById("g-date").value;
      p.giving = true;
      p.givingAmount = isNaN(amount) ? 0 : amount;
      p.givingDate = date || toISODate(todayAtMidnight());
      pendingGivingTargetId = null;
      closeModal("giving-modal");
      save();
      render();
    });

    // delegated table events
    document.getElementById("partners-tbody").addEventListener("change", function (e) {
      var target = e.target;
      var tr = target.closest("tr");
      if (!tr) return;
      var id = tr.dataset.id;
      if (target.dataset.action === "toggle-giving") {
        toggleGiving(id, target.checked);
      } else if (target.dataset.action === "toggle-prayed") {
        togglePrayed(id, target.checked);
      }
    });

    document.getElementById("partners-tbody").addEventListener("click", function (e) {
      var target = e.target;
      if (target.dataset.action === "remove") {
        var tr = target.closest("tr");
        var id = tr.dataset.id;
        var p = findPartner(id);
        if (p && confirm("Remove " + p.name + " from your partners?")) {
          removePartner(id);
        }
      }
    });

    document.getElementById("giving-tbody").addEventListener("click", function (e) {
      var target = e.target;
      if (target.dataset.action === "edit-giving") {
        var tr = target.closest("tr");
        var id = tr.dataset.id;
        var p = findPartner(id);
        if (p) openGivingModal(p, false);
      }
    });

    // service worker registration for PWA support
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {
          // offline support just won't be available; app still functions
        });
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
