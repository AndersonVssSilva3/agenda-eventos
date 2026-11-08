import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BUCKET = 'event-files';
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ICONO = { evento: '🎉', clase: '📚', cita: '🩺' };
const HORIZONTE_DIAS = 90; // cuántos días hacia adelante mostrar en la agenda

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hhmm = (t) => (t ? t.slice(0, 5) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let user = null;
let events = [];
let urlMap = {};          // path -> signed url
let editingFiles = [];    // archivos ya guardados del evento en edición
let removedPaths = [];    // archivos a borrar al guardar
let filtroTipo = 'todos';
let busqueda = '';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

/* ---------- Manejo del Tema (Claro/Oscuro/Sistema) ---------- */
const btnTheme = $('#btn-theme');
const temas = ['light', 'dark', 'system'];
let temaActual = localStorage.getItem('tema') || 'system';
// Reloj en vivo
function updateClock() {
  const clockEl = $('#live-clock');
  if (clockEl) {
    const now = new Date();
    const options = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    clockEl.textContent = now.toLocaleDateString('es-ES', options).replace(',', ' •');
  }
}
setInterval(updateClock, 1000);
updateClock();
function aplicarTema() {
  const body = document.body;
  body.classList.remove('dark-theme');
  
  if (temaActual === 'dark') {
    body.classList.add('dark-theme');
    if(btnTheme) btnTheme.textContent = '🌙';
  } else if (temaActual === 'light') {
    if(btnTheme) btnTheme.textContent = '☀️';
  } else {
    // Modo sistema
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) body.classList.add('dark-theme');
    if(btnTheme) btnTheme.textContent = '💻';
  }
}

if(btnTheme) {
  btnTheme.addEventListener('click', () => {
    let idx = temas.indexOf(temaActual);
    temaActual = temas[(idx + 1) % temas.length];
    localStorage.setItem('tema', temaActual);
    aplicarTema();
  });
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (temaActual === 'system') aplicarTema();
});

// Inicializar tema
aplicarTema();


/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

/* ---------- Autenticación ---------- */
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.elements.email.value.trim();
  const password = e.target.elements.password.value;
  const mode = e.submitter?.dataset.mode || 'login';
  const { error } = mode === 'signup'
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });
  if (error) return toast(error.message);
  if (mode === 'signup') toast('Cuenta creada. Si te pide confirmar, revisa tu correo.');
});

$('#btn-logout').addEventListener('click', () => sb.auth.signOut());

sb.auth.onAuthStateChange((_evt, session) => {
  user = session?.user ?? null;
  $('#view-auth').classList.toggle('hidden', !!user);
  $('#view-app').classList.toggle('hidden', !user);
  if (user) load();
});

/* ---------- Carga de datos ---------- */
async function load() {
  const { data, error } = await sb.from('events').select('*').order('event_date').order('start_time');
  if (error) return toast('Error al cargar: ' + error.message);
  events = data;

  const paths = events.flatMap((ev) => (ev.files || []).map((f) => f.path));
  urlMap = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (signed || []).forEach((s) => { if (s.signedUrl) urlMap[s.path] = s.signedUrl; });
  }
  render();
}

/* ---------- Ocurrencias (un día, rango diario o días de la semana) ---------- */
const DIAS_CORTO = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const TODOS_LOS_DIAS = [0, 1, 2, 3, 4, 5, 6];

// Días de la semana en que se repite (null = no se repite por día de semana)
function evWeekdays(ev) {
  if (Array.isArray(ev.weekdays) && ev.weekdays.length) return ev.weekdays;
  if (ev.recurring_weekday != null) return [ev.recurring_weekday]; // formato antiguo
  return null;
}
const isRecurring = (ev) => evWeekdays(ev) != null || !!ev.end_date;

function occursOn(ev, dateStr) {
  if (dateStr < ev.event_date) return false;
  if (ev.end_date && dateStr > ev.end_date) return false;
  const wds = evWeekdays(ev);
  if (wds) return wds.includes(parseYmd(dateStr).getDay());
  if (ev.end_date) return true;          // rango sin días elegidos = todos los días
  return dateStr === ev.event_date;      // evento de un solo día
}

const fmtCorto = (s) => parseYmd(s).toLocaleDateString('es', { day: 'numeric', month: 'short' });

function recurrenceLabel(ev) {
  const wds = evWeekdays(ev);
  const hasta = ev.end_date ? ` · hasta ${fmtCorto(ev.end_date)}` : '';
  if (!wds) return ev.end_date ? `📆 ${fmtCorto(ev.event_date)} → ${fmtCorto(ev.end_date)}` : '';
  if (wds.length === 7) return `🔁 Todos los días${hasta}`;
  return `🔁 ${[1, 2, 3, 4, 5, 6, 0].filter((d) => wds.includes(d)).map((d) => DIAS_CORTO[d]).join(' ')}${hasta}`;
}

function passesFilter(ev) {
  if (filtroTipo !== 'todos' && ev.kind !== filtroTipo) return false;
  if (busqueda) {
    const hay = `${ev.title} ${ev.location || ''} ${ev.notes || ''}`.toLowerCase();
    if (!hay.includes(busqueda)) return false;
  }
  return true;
}

/* ---------- Render ---------- */
let mesActual = new Date();
let diaSeleccionado = ymd(new Date());

function labelDia(dateStr) {
  const hoy = ymd(new Date());
  const manana = ymd(addDays(new Date(), 1));
  if (dateStr === hoy) return 'Hoy';
  if (dateStr === manana) return 'Mañana';
  return parseYmd(dateStr).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}

function eventsOn(dateStr) {
  return events.filter(passesFilter).filter((ev) => occursOn(ev, dateStr)).sort((a, b) => a.start_time.localeCompare(b.start_time));
}

function cardHTML(ev, dateStr = null) {
  const files = ev.files || [];
  const imgs = files.filter((f) => f.type?.startsWith('image/') && urlMap[f.path]);
  const docs = files.filter((f) => !(f.type?.startsWith('image/')) && urlMap[f.path]);
  const horas = hhmm(ev.start_time) + (ev.end_time ? ` – ${hhmm(ev.end_time)}` : '');
  
  // Calcular si el evento está en curso o ya pasó (solo si es para hoy)
  let statusClass = '';
  let statusLabel = '';
  const now = new Date();
  const todayStr = ymd(now);
  
  // Solo calculamos el estado si estamos en la vista de Hoy
  if (dateStr) {
    const start = new Date(`${dateStr}T${ev.start_time}`);
    let end;
    if (ev.end_time) {
      end = new Date(`${dateStr}T${ev.end_time}`);
    } else {
      end = new Date(start.getTime() + 60 * 60 * 1000); // Si no hay fin, asume 1 hora
    }
    
    if (dateStr === todayStr) {
      if (now >= start && now <= end) {
        statusClass = 'live';
        statusLabel = '<span class="live-badge">🔴 EN CURSO</span>';
      } else if (now > end) {
        statusClass = 'past';
        statusLabel = '<span class="past-badge">✓ FINALIZADO</span>';
      }
    }
  }

  return `
  <article class="ev ${esc(ev.kind)} ${statusClass}">
    <div class="ev-head">
      <div style="flex:1">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="ev-badge ${esc(ev.kind)}">${ICONO[ev.kind] || ''} ${esc(ev.kind)}</span>
          ${statusLabel}
        </div>
        <div class="ev-title">${esc(ev.title)}</div>
        <div class="ev-meta">🕒 ${esc(horas)}</div>
        ${isRecurring(ev) ? `<div class="ev-meta">${esc(recurrenceLabel(ev))}</div>` : ''}
        ${ev.location ? `<div class="ev-meta">📍 ${esc(ev.location)}</div>` : ''}
        ${ev.remind_minutes >= 0 ? `<div class="ev-meta">🔔 ${ev.remind_minutes === 0 ? 'A la hora' : ev.remind_minutes >= 1440 ? '1 día antes' : ev.remind_minutes + ' min antes'}</div>` : ''}
      </div>
    </div>
    ${ev.notes ? `<p class="ev-notes">${esc(ev.notes)}</p>` : ''}
    ${(ev.links || []).length ? `<div class="chips">${ev.links.map((l) => `<a class="chip" href="${esc(l)}" target="_blank" rel="noopener">🔗 ${esc(l.replace(/^https?:\/\//, '').slice(0, 32))}</a>`).join('')}</div>` : ''}
    ${imgs.length ? `<div class="thumbs">${imgs.map((f) => `<a href="${urlMap[f.path]}" target="_blank" rel="noopener"><img src="${urlMap[f.path]}" alt="${esc(f.name)}" loading="lazy"></a>`).join('')}</div>` : ''}
    ${docs.length ? `<div class="chips">${docs.map((f) => `<a class="chip" href="${urlMap[f.path]}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a>`).join('')}</div>` : ''}
    <div class="ev-actions">
      <button class="btn small" data-edit="${ev.id}">✏️ Editar</button>
      <button class="btn small danger" data-del="${ev.id}">🗑 Eliminar</button>
    </div>
  </article>`;
}

function timelineHTML(dateStr) {
  const list = eventsOn(dateStr);
  if (!list.length) return '<div class="empty">Nada para este día.<br>Toca ＋ para agregar algo.</div>';
  let html = '';
  for (const ev of list) {
    const dur = ev.end_time ? `→ ${hhmm(ev.end_time)}` : '';
    html += `
      <div class="tl-item">
        <div class="tl-time">${hhmm(ev.start_time)}${dur ? `<small>${dur}</small>` : ''}</div>
        <div>${cardHTML(ev, dateStr)}</div>
      </div>`;
  }
  return html;
}

function renderAgenda() {
  const hoy = ymd(new Date());
  const manana = ymd(addDays(new Date(), 1));
  const listHoy = eventsOn(hoy);
  const listMan = eventsOn(manana);
  let html = '';

  html += `<div class="timeline"><div class="day-title">📌 Hoy · ${labelDia(hoy)}</div>${timelineHTML(hoy)}</div>`;
  if (listMan.length) {
    html += `<div class="timeline" style="margin-top:1.5rem"><div class="day-title">➡️ Mañana · ${labelDia(manana)}</div>${timelineHTML(manana)}</div>`;
  }

  const proximos = [];
  for (let i = 2; i <= 7; i++) {
    const d = ymd(addDays(new Date(), i));
    const l = eventsOn(d);
    if (l.length) proximos.push({ d, l });
  }
  if (proximos.length) {
    html += `<div class="timeline" style="margin-top:1.5rem"><div class="day-title">🗓️ Próximos 7 días</div>`;
    for (const { d, l } of proximos) {
      html += `<div class="day-title" style="margin-top:.8rem;font-size:.75rem">${esc(labelDia(d))}</div>`;
      html += l.map((ev) => cardHTML(ev)).join('');
    }
    html += `</div>`;
  }

  $('#agenda-list').innerHTML = html || '<div class="empty">Sin eventos próximos.</div>';
}

function renderCalendar() {
  const y = mesActual.getFullYear();
  const m = mesActual.getMonth();
  $('#month-title').textContent = mesActual.toLocaleDateString('es', { month: 'long', year: 'numeric' });

  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // lunes=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const today = ymd(new Date());

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(y, m - 1, prevDays - i);
    cells.push({ date: ymd(d), other: true, num: d.getDate() });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(y, m, i);
    cells.push({ date: ymd(d), other: false, num: i });
  }
  while (cells.length % 7 !== 0) {
    const d = new Date(y, m + 1, cells.length - startDow - daysInMonth + 1);
    cells.push({ date: ymd(d), other: true, num: d.getDate() });
  }

  const html = cells.map((c) => {
    const evs = eventsOn(c.date);
    const tipos = [...new Set(evs.map((e) => e.kind))];
    const cls = ['cal-day'];
    if (c.other) cls.push('other');
    if (c.date === today) cls.push('today');
    if (c.date === diaSeleccionado) cls.push('selected');
    const dots = tipos.length
      ? `<div class="cal-dots">${tipos.map((t) => `<span class="${t}"></span>`).join('')}</div>`
      : '';
    return `<div class="${cls.join(' ')}" data-date="${c.date}">${c.num}${dots}</div>`;
  }).join('');

  $('#calendar').innerHTML = html;

  const detalle = eventsOn(diaSeleccionado);
  $('#day-detail').innerHTML = `
    <h3 style="margin: 1rem 0 .5rem; text-transform: capitalize;">${esc(labelDia(diaSeleccionado))}</h3>
    ${detalle.length ? detalle.map((ev) => cardHTML(ev)).join('') : '<div class="empty">Día sin eventos.</div>'}
  `;
}

function renderSchedule() {
  const hoy = ymd(new Date());
  const rec = events.filter((e) => isRecurring(e) && (!e.end_date || e.end_date >= hoy));
  if (!rec.length) {
    $('#schedule').innerHTML = '<div class="empty">Aún no tienes horario.<br>Crea una clase o cita y elige “Todos los días” o “Ciertos días de la semana”.</div>';
    return;
  }
  let html = '';
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const list = rec.filter((e) => (evWeekdays(e) || TODOS_LOS_DIAS).includes(wd)).sort((a, b) => a.start_time.localeCompare(b.start_time));
    if (!list.length) continue;
    html += `<div class="sched-day"><h3 style="margin: 1rem 0 .5rem;">${DIAS[wd]}</h3>${list.map((e) => cardHTML(e)).join('')}</div>`;
  }
  $('#schedule').innerHTML = html;
}

function render() {
  renderAgenda();
  renderCalendar();
  renderSchedule();
}

/* ---------- Pestañas / filtros ---------- */
document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav-item[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $('#tab-hoy').classList.toggle('hidden', b.dataset.tab !== 'hoy');
  $('#tab-mes').classList.toggle('hidden', b.dataset.tab !== 'mes');
  $('#tab-horario').classList.toggle('hidden', b.dataset.tab !== 'horario');
}));

$('#fab-nav').addEventListener('click', () => openForm());
$('#search').addEventListener('input', (e) => { busqueda = e.target.value.trim().toLowerCase(); render(); });
$('#filter-kind').addEventListener('change', (e) => { filtroTipo = e.target.value; render(); });
$('#prev-month').addEventListener('click', () => { mesActual = new Date(mesActual.getFullYear(), mesActual.getMonth() - 1, 1); renderCalendar(); });
$('#next-month').addEventListener('click', () => { mesActual = new Date(mesActual.getFullYear(), mesActual.getMonth() + 1, 1); renderCalendar(); });

$('#calendar').addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-day[data-date]');
  if (!cell) return;
  diaSeleccionado = cell.dataset.date;
  renderCalendar();
});

/* ---------- Formulario ---------- */
const dlg = $('#dlg');
const form = $('#event-form');

function renderExistingFiles() {
  $('#existing-files').innerHTML = editingFiles.map((f, i) =>
    `<span class="chip">📎 ${esc(f.name)} <button type="button" data-rm="${i}" title="Quitar">×</button></span>`).join('');
}

function wdBoxes() { return [...form.querySelectorAll('input[name="wd"]')]; }

function updateFreqUI() {
  const el = form.elements;
  const freq = el.freq.value;
  $('#wrap-end').classList.toggle('hidden', freq === 'once');
  $('#wrap-days').classList.toggle('hidden', freq !== 'weekly');
  $('#lbl-start').textContent = freq === 'once' ? 'Fecha' : 'Desde';
  // Al elegir "ciertos días", marca por defecto el día de la fecha de inicio
  if (freq === 'weekly' && !wdBoxes().some((b) => b.checked) && el.event_date.value) {
    const d = String(parseYmd(el.event_date.value).getDay());
    wdBoxes().forEach((b) => { b.checked = b.value === d; });
  }
  el.end_date.min = el.event_date.value || '';
  const hint = $('#freq-hint');
  hint.classList.toggle('hidden', freq === 'once');
  hint.textContent = freq === 'daily'
    ? 'Se repetirá cada día a la misma hora entre las dos fechas. Sin fecha “Hasta”, se repite siempre.'
    : 'Se repetirá en los días marcados. Sin fecha “Hasta”, se repite siempre.';
}

function openForm(ev = null) {
  form.reset();
  editingFiles = ev ? [...(ev.files || [])] : [];
  removedPaths = [];
  const el = form.elements;
  $('#dlg-title').textContent = ev ? 'Editar' : 'Nuevo';
  el.event_id.value = ev?.id || '';
  if (ev) {
    el.kind.value = ev.kind;
    el.titulo.value = ev.title;
    el.event_date.value = ev.event_date;
    el.start_time.value = hhmm(ev.start_time);
    el.end_time.value = hhmm(ev.end_time);
    el.remind.value = String(ev.remind_minutes);
    const wds = evWeekdays(ev);
    el.freq.value = wds ? (wds.length === 7 ? 'daily' : 'weekly') : (ev.end_date ? 'daily' : 'once');
    el.end_date.value = ev.end_date || '';
    wdBoxes().forEach((b) => { b.checked = !!wds?.includes(Number(b.value)); });
    el.lugar.value = ev.location || '';
    el.notas.value = ev.notes || '';
    el.links.value = (ev.links || []).join('\n');
  } else {
    el.event_date.value = ymd(new Date());
  }
  updateFreqUI();
  renderExistingFiles();
  dlg.showModal();
}

$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#existing-files').addEventListener('click', (e) => {
  const i = e.target.dataset.rm;
  if (i === undefined) return;
  removedPaths.push(editingFiles[i].path);
  editingFiles.splice(Number(i), 1);
  renderExistingFiles();
});

form.elements.kind.addEventListener('change', (e) => {
  if (e.target.value === 'clase' && form.elements.freq.value === 'once') {
    form.elements.freq.value = 'weekly';
    updateFreqUI();
  }
});
form.elements.freq.addEventListener('change', updateFreqUI);
form.elements.event_date.addEventListener('change', updateFreqUI);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = form.elements;
  const freq = el.freq.value;
  const endDate = freq === 'once' ? null : (el.end_date.value || null);
  let weekdays = null;
  if (freq === 'daily') weekdays = TODOS_LOS_DIAS;
  if (freq === 'weekly') {
    weekdays = wdBoxes().filter((b) => b.checked).map((b) => Number(b.value)).sort();
    if (!weekdays.length) return toast('Marca al menos un día de la semana');
  }
  if (endDate && endDate < el.event_date.value) return toast('La fecha “Hasta” debe ser igual o posterior a la de inicio');

  const btn = $('#btn-save');
  btn.disabled = true; btn.textContent = 'Guardando…';

  try {
    const id = el.event_id.value || crypto.randomUUID();
    const files = [...editingFiles];

    for (const file of el.attach.files) {
      const safe = file.name.replace(/[^\w.\-]/g, '_');
      const path = `${user.id}/${id}/${Date.now()}-${safe}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file);
      if (error) throw new Error(`No se pudo subir ${file.name}: ${error.message}`);
      files.push({ name: file.name, path, type: file.type });
    }

    const links = el.links.value.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u));

    const row = {
      id,
      user_id: user.id,
      kind: el.kind.value,
      title: el.titulo.value.trim(),
      event_date: el.event_date.value,
      start_time: el.start_time.value,
      end_time: el.end_time.value || null,
      location: el.lugar.value.trim() || null,
      notes: el.notas.value.trim() || null,
      links,
      files,
      remind_minutes: Number(el.remind.value),
      end_date: endDate,
      weekdays,
      recurring_weekday: null, // reemplazado por "weekdays"
    };

    const { error } = await sb.from('events').upsert(row);
    if (error) throw error;

    if (removedPaths.length) await sb.storage.from(BUCKET).remove(removedPaths);

    dlg.close();
    toast('Guardado ✅');
    await load();
  } catch (err) {
    toast(err.message || 'Error al guardar');
  } finally {
    btn.disabled = false; btn.textContent = 'Guardar';
  }
});

document.addEventListener('click', async (e) => {
  const editId = e.target.dataset?.edit;
  const delId = e.target.dataset?.del;
  if (editId) return openForm(events.find((x) => x.id === editId));
  if (delId) {
    const ev = events.find((x) => x.id === delId);
    if (!confirm(`¿Eliminar "${ev.title}"?` + (isRecurring(ev) ? '\nSe borrarán todas sus repeticiones.' : ''))) return;
    const paths = (ev.files || []).map((f) => f.path);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    const { error } = await sb.from('events').delete().eq('id', delId);
    if (error) return toast(error.message);
    toast('Eliminado');
    load();
  }
});

/* ---------- Sonido y vibración ---------- */
const VIBRACION = [500, 200, 500, 200, 500, 200, 500];
let audioCtx = null;

// El navegador solo deja reproducir audio después de que tocas la pantalla
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sin audio */ }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function playChime() {
  try {
    unlockAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [880, 1175, 880, 1175].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + i * 0.35;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    });
  } catch { /* sin audio */ }
}

function alertar() {
  playChime();
  try { navigator.vibrate?.(VIBRACION); } catch { /* sin vibración */ }
}

// Si la app está abierta cuando llega un recordatorio, suena y vibra aquí también
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'reminder') return;
    alertar();
    toast(`🔔 ${e.data.body}`);
  });
}

/* ---------- Notificaciones push ---------- */
function urlB64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$('#btn-push').addEventListener('click', async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return toast('Este navegador no soporta push. En iPhone: Compartir → Añadir a pantalla de inicio.');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Permiso de notificaciones denegado.');

    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.length < 80 || VAPID_PUBLIC_KEY.startsWith('sb_')) {
      return toast('⚠️ Configura una VAPID_PUBLIC_KEY válida en config.js');
    }

    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      }));

    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert(
      { user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
      { onConflict: 'endpoint' }
    );
    if (error) throw error;
    // Notificación de prueba: así sabes si tu teléfono suena/vibra
    await reg.showNotification('Hola 👋', {
      body: 'Así te avisaré: Tienes Clase a las 10:30 en Aula 5 (en 10 min)',
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: VIBRACION,
      silent: false,
      tag: 'prueba',
      renotify: true,
    });
    alertar();
    toast('🔔 Notificaciones activadas. Te envié una de prueba.');
  } catch (err) {
    console.error(err);
    toast('No se pudo activar: ' + (err.message || err));
  }
});