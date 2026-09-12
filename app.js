(function () {
  "use strict";

  var STORAGE_KEY = "gospelPartners.v1";
  var SETTINGS_KEY = "gospelPartners.settings.v1";
  var DAY_MS = 24 * 60 * 60 * 1000;
  var DEFAULT_MONTH_RANGE = 3;
  var GRIP_ICON =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="5" cy="3" r="1.3" fill="currentColor"/><circle cx="11" cy="3" r="1.3" fill="currentColor"/>' +
    '<circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/>' +
    '<circle cx="5" cy="13" r="1.3" fill="currentColor"/><circle cx="11" cy="13" r="1.3" fill="currentColor"/>' +
    "</svg>";

  /** @type {Array<Object>} */
  var partners = [];
  var settings = { monthRange: DEFAULT_MONTH_RANGE };
  var pendingGivingTargetId = null; // id awaiting an amount from the giving modal
  var pendingGivingIsNewPartner = false;
  var pendingDateStartedId = null;
  var givingSort = { column: null, dir: "asc" };

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

  // Compact form used in the table so every column fits without a horizontal
  // scrollbar on narrow screens - the exact day is still available by tapping
  // through to the date-started popup or the giving edit modal.
  function formatMonthYear(s) {
    var d = parseISODate(s);
    if (!d) return "";
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  function formatMonthDay(s) {
    var d = parseISODate(s);
    if (!d) return "—";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatMoney(n) {
    var num = Number(n) || 0;
    return "$" + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Adds n months to a date while preserving the day-of-month where possible
  // (e.g. Jan 31 + 1 month lands on Feb 28, not rolling over into March).
  function addMonthsPreserveDay(date, n) {
    var day = date.getDate();
    var d = new Date(date.getTime());
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, daysInMonth));
    return d;
  }

  function monthIndex(d) {
    return d.getFullYear() * 12 + d.getMonth();
  }

  // A giving date keeps showing the same day all month long (even after that day
  // has passed) and only rolls forward once the calendar reaches a new month -
  // i.e. on/after the 1st of the following month, it jumps to the same day next month.
  function rollGivingDatesForward() {
    var today = todayAtMidnight();
    var todayIdx = monthIndex(today);
    var changed = false;
    partners.forEach(function (p) {
      if (!p.giving || !p.givingDate) return;
      var d = parseISODate(p.givingDate);
      if (!d) return;
      var guard = 0;
      while (monthIndex(d) < todayIdx && guard < 1200) {
        d = addMonthsPreserveDay(d, 1);
        changed = true;
        guard++;
      }
      p.givingDate = toISODate(d);
    });
    return changed;
  }

  // Whether a giving date falls on or before today - i.e. this month's gift is due/given.
  function isGivingDatePast(givingDate) {
    var d = parseISODate(givingDate);
    if (!d) return false;
    var today = todayAtMidnight();
    return d.getTime() <= today.getTime();
  }

  function durationMessage(partner) {
    var start = parseISODate(partner.dateStarted);
    if (!start) return "";
    var today = todayAtMidnight();
    var years = today.getFullYear() - start.getFullYear();
    var months = today.getMonth() - start.getMonth();
    if (today.getDate() < start.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    if (years < 0) { years = 0; months = 0; }

    var parts = [];
    if (years > 0) parts.push(years + (years === 1 ? " year" : " years"));
    if (months > 0) parts.push(months + (months === 1 ? " month" : " months"));
    var durationStr = parts.length ? parts.join(" and ") : "less than a month";

    return "You've been partnering with " + partner.name + " for " + durationStr + "!";
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
      var startedDisplay = p.dateStarted
        ? '<span class="date-started-tag" data-action="edit-date-started">Since ' + formatMonthYear(p.dateStarted) + "</span>"
        : '<span class="date-started-tag hint-add-date" data-action="edit-date-started">+ Add date</span>';

      tr.innerHTML =
        '<td class="handle-col"><span class="drag-handle" data-role="drag-handle" aria-label="Drag to reorder ' + escapeHtml(p.name) + '">' + GRIP_ICON + "</span></td>" +
        '<td class="name-cell" data-label="Name">' +
          "<strong>" + escapeHtml(p.name) + "</strong>" +
          '<span class="ministry-line">' + escapeHtml(p.ministry) + "</span>" +
          startedDisplay +
        "</td>" +
        '<td class="center" data-label="Giving"><input type="checkbox" class="checkbox giving-checkbox" data-action="toggle-giving" ' + (p.giving ? "checked" : "") + "></td>" +
        '<td class="' + dateClass + '" data-label="Sched.">' + formatMonthDay(p.scheduled) + "</td>" +
        '<td class="center" data-label="Prayed"><input type="checkbox" class="checkbox" data-action="toggle-prayed" ' + (p.prayed ? "checked" : "") + "></td>" +
        '<td class="center remove-cell" data-label=""><button type="button" class="row-remove" data-action="remove" title="Remove partner" aria-label="Remove ' + escapeHtml(p.name) + '">&times;</button></td>';

      tbody.appendChild(tr);
    });
  }

  function renderGivingTable() {
    var tbody = document.getElementById("giving-tbody");
    var emptyEl = document.getElementById("giving-empty");
    var givers = partners.filter(function (p) { return p.giving; });

    if (givingSort.column === "amount") {
      givers.sort(function (a, b) {
        var diff = (Number(a.givingAmount) || 0) - (Number(b.givingAmount) || 0);
        return givingSort.dir === "asc" ? diff : -diff;
      });
    } else if (givingSort.column === "date") {
      givers.sort(function (a, b) {
        var da = parseISODate(a.givingDate);
        var db = parseISODate(b.givingDate);
        var diff = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
        return givingSort.dir === "asc" ? diff : -diff;
      });
    }

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
      var dateChipClass = "date-chip" + (isGivingDatePast(p.givingDate) ? " date-chip-past" : "");
      tr.innerHTML =
        '<td class="name-cell" data-label="Name"><strong>' + escapeHtml(p.name) + "</strong></td>" +
        '<td class="amount-cell editable" data-label="Amount" data-action="edit-giving">' + formatMoney(p.givingAmount) + "</td>" +
        '<td class="editable" data-label="Date" data-action="edit-giving"><span class="' + dateChipClass + '">' + formatDisplayDate(p.givingDate) + "</span></td>";
      tbody.appendChild(tr);
    });

    document.getElementById("giving-total").textContent = formatMoney(total);
    document.getElementById("giving-count").textContent = String(givers.length);

    document.querySelectorAll(".sort-arrow").forEach(function (el) {
      var col = el.dataset.arrow;
      if (givingSort.column === col) {
        el.textContent = givingSort.dir === "asc" ? "▲" : "▼";
      } else {
        el.textContent = "";
      }
    });
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

  function openDateStartedModal(partner) {
    pendingDateStartedId = partner.id;
    document.getElementById("ds-modal-title").textContent = partner.name;
    var durationEl = document.getElementById("ds-duration-text");
    if (partner.dateStarted) {
      durationEl.textContent = durationMessage(partner);
      durationEl.style.display = "block";
    } else {
      durationEl.textContent = "";
      durationEl.style.display = "none";
    }
    document.getElementById("ds-date").value = partner.dateStarted || "";
    openModal("datestarted-modal");
  }

  // ---------- actions ----------
  function addPartner(data) {
    var p = {
      id: "p" + Date.now() + Math.floor(Math.random() * 1000),
      name: data.name,
      ministry: data.ministry,
      dateStarted: null,
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

  function reorderPartners(idsInOrder) {
    var map = {};
    partners.forEach(function (p) { map[p.id] = p; });
    var reordered = idsInOrder.map(function (id) { return map[id]; }).filter(Boolean);
    // Safety net: keep any partner not present in idsInOrder (shouldn't normally happen).
    partners.forEach(function (p) {
      if (reordered.indexOf(p) === -1) reordered.push(p);
    });
    partners = reordered;
    recomputeSchedule();
    save();
    render();
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

  // ---------- drag reorder ----------
  function initDragReorder() {
    var tbody = document.getElementById("partners-tbody");
    var draggingEl = null;
    var startY = 0;

    function onPointerMove(e) {
      if (!draggingEl) return;
      var dy = e.clientY - startY;
      draggingEl.style.transform = "translateY(" + dy + "px)";

      var rows = Array.from(tbody.children);
      var idx = rows.indexOf(draggingEl);
      var pointerY = e.clientY;

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row === draggingEl) continue;
        var rect = row.getBoundingClientRect();
        var mid = rect.top + rect.height / 2;
        if (i < idx && pointerY < mid) {
          tbody.insertBefore(draggingEl, row);
          startY = e.clientY;
          draggingEl.style.transform = "translateY(0px)";
          break;
        } else if (i > idx && pointerY > mid) {
          tbody.insertBefore(draggingEl, row.nextSibling);
          startY = e.clientY;
          draggingEl.style.transform = "translateY(0px)";
          break;
        }
      }
    }

    function onPointerUp() {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      if (!draggingEl) return;
      draggingEl.style.transform = "";
      draggingEl.style.position = "";
      draggingEl.classList.remove("dragging");
      document.body.style.userSelect = "";

      var newOrderIds = Array.from(tbody.children).map(function (tr) { return tr.dataset.id; });
      draggingEl = null;
      reorderPartners(newOrderIds);
    }

    tbody.addEventListener("pointerdown", function (e) {
      var handle = e.target.closest('[data-role="drag-handle"]');
      if (!handle) return;
      var tr = handle.closest("tr");
      if (!tr) return;
      e.preventDefault();
      draggingEl = tr;
      startY = e.clientY;
      tr.style.position = "relative";
      tr.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    });
  }

  // ---------- events ----------
  function init() {
    load();
    // Any giving date already in the past rolls forward to its next monthly
    // occurrence so the giving tab always shows the upcoming date.
    var rolled = rollGivingDatesForward();
    // Only assign schedule dates on first run / for partners that don't have one yet.
    // Once a date is assigned it stays fixed until the roster changes (add, remove,
    // or a prayed toggle), so dates don't drift just from reopening the app.
    var needsSchedule = partners.some(function (p) { return !p.prayed && !p.scheduled; });
    if (needsSchedule) recomputeSchedule();
    if (rolled || needsSchedule) save();
    document.getElementById("month-range").value = String(settings.monthRange);
    render();
    initDragReorder();

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
      var proceed = confirm("Start a new " + label + " prayer cycle?");
      if (!proceed) return;
      startNewCycle(val);
    });

    // giving table sortable headers
    document.querySelectorAll("#view-giving th.sortable").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = th.dataset.sort;
        if (givingSort.column === col) {
          givingSort.dir = givingSort.dir === "asc" ? "desc" : "asc";
        } else {
          givingSort.column = col;
          givingSort.dir = "asc";
        }
        renderGivingTable();
      });
    });

    // fab
    document.getElementById("add-btn").addEventListener("click", function () {
      document.getElementById("add-form").reset();
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
        } else if (modalId === "datestarted-modal") {
          pendingDateStartedId = null;
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
          } else if (backdrop.id === "datestarted-modal") {
            pendingDateStartedId = null;
          }
        }
      });
    });

    // add partner form
    document.getElementById("add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = document.getElementById("f-name").value.trim();
      var ministry = document.getElementById("f-ministry").value.trim();
      var giving = document.getElementById("f-giving").checked;
      if (!name || !ministry) return;
      closeModal("add-modal");
      addPartner({ name: name, ministry: ministry, giving: giving });
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

    // date started form
    document.getElementById("ds-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var p = findPartner(pendingDateStartedId);
      if (!p) { closeModal("datestarted-modal"); return; }
      var val = document.getElementById("ds-date").value;
      p.dateStarted = val || null;
      pendingDateStartedId = null;
      closeModal("datestarted-modal");
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
      var actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      var tr = actionEl.closest("tr");
      if (!tr) return;
      var id = tr.dataset.id;
      var action = actionEl.dataset.action;
      if (action === "remove") {
        var p = findPartner(id);
        if (p && confirm("Remove " + p.name + " from your partners?")) {
          removePartner(id);
        }
      } else if (action === "edit-date-started") {
        var partner = findPartner(id);
        if (partner) openDateStartedModal(partner);
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

    // service worker registration for PWA support.
    // Also actively checks for a newer version and reloads once it takes over,
    // so code changes show up on next launch instead of staying stuck on a
    // cached copy.
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker
          .register("sw.js")
          .then(function (reg) {
            reg.update();
            reg.addEventListener("updatefound", function () {
              var installing = reg.installing;
              if (!installing) return;
              installing.addEventListener("statechange", function () {
                if (installing.state === "installed" && navigator.serviceWorker.controller) {
                  installing.postMessage("skipWaiting");
                }
              });
            });
          })
          .catch(function () {
            // offline support just won't be available; app still functions
          });

        var reloadedOnce = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          if (reloadedOnce) return;
          reloadedOnce = true;
          window.location.reload();
        });
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
