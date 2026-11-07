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
  else nativo?.programar({ alarmas: [] }).catch(console.error); // al salir, el celular deja de avisar
});

/* ---------- Carga de datos ---------- */
async function load() {
  const { data, error } = await sb.from('events').select('*').order('event_date').order('start_time');
  if (error) return toast('Error al cargar: ' + error.message);
  events = data;
  revisarRecordatorios();
  sincronizarAlarmasNativas();

  const paths = events.flatMap((ev) => (ev.files || []).map((f) => f.path));
  urlMap = {};
  if (paths.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    (signed || []).forEach((s) => { if (s.signedUrl) urlMap[s.path] = s.signedUrl; });
  }
  render();
}

/* ---------- Ocurrencias (eventos únicos y semanales) ---------- */
// Los eventos anteriores a recurring_days solo tienen recurring_weekday.
function diasDe(ev) {
  if (ev.recurring_days?.length) return ev.recurring_days;
  return ev.recurring_weekday == null ? [] : [ev.recurring_weekday];
}

function textoDias(ev) {
  const dias = diasDe(ev);
  if (dias.length === 7) return 'todos los días';
  const orden = [1, 2, 3, 4, 5, 6, 0].filter((d) => dias.includes(d));
  if (orden.join() === '1,2,3,4,5') return 'lunes a viernes';
  return orden.map((d) => DIAS[d].toLowerCase()).join(', ');
}

function resumenFechas(fechas) {
  const corta = (s) => parseYmd(s).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  if (fechas.length <= 3) return fechas.map(corta).join(', ');
  return `${fechas.slice(0, 2).map(corta).join(', ')} y ${fechas.length - 2} más`;
}

function occurrences(ev, from, days) {
  const start = parseYmd(ev.event_date);
  const end = addDays(from, days);
  if (ev.specific_dates?.length) {
    const desde = ymd(from);
    const hasta = ymd(end);
    return ev.specific_dates.filter((f) => f >= desde && f <= hasta);
  }
  const dias = diasDe(ev);
  if (!dias.length) return start >= from && start <= end ? [ymd(start)] : [];
  const out = [];
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    if (dias.includes(d.getDay()) && d >= start) out.push(ymd(d));
  }
  return out;
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
  return events.filter(passesFilter).filter((ev) =>
    occurrences(ev, parseYmd(dateStr), 0).includes(dateStr)
  ).sort((a, b) => a.start_time.localeCompare(b.start_time));
}

function cardHTML(ev, isTimeline = false, dateStr = ev.event_date) {
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
  if (isTimeline) {
    // Se usa la fecha de la ocurrencia: en las clases semanales, event_date es solo el primer día.
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
        <div class="ev-meta">🕒 ${esc(horas)} ${diasDe(ev).length ? ` · 🔁 ${esc(textoDias(ev))}` : ''}${ev.specific_dates?.length ? ` · 📅 ${esc(resumenFechas(ev.specific_dates))}` : ''}</div>
        ${ev.location ? `<div class="ev-meta">📍 ${esc(ev.location)}</div>` : ''}
        ${ev.remind_minutes >= 0 ? `<div class="ev-meta">🔔 ${ev.remind_minutes === 0 ? 'A la hora' : ev.remind_minutes >= 1440 ? '1 día antes' : ev.remind_minutes + ' min antes'}</div>` : ''}
      </div>
    </div>
    ${ev.notes ? `<p class="ev-notes">${esc(ev.notes)}</p>` : ''}
    ${(ev.links || []).length ? `<div class="chips">${ev.links.map((l) => `<a class="chip" href="${esc(l)}" target="_blank" rel="noopener" data-enlace>🔗 ${esc(l.replace(/^https?:\/\//, '').slice(0, 32))}</a>`).join('')}</div>` : ''}
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
        <div>${cardHTML(ev, true, dateStr)}</div>
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

// Días que se muestran en la cuadrícula de un mes, de lunes a domingo.
function celdasMes(y, m) {
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // lunes=0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

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
  return cells;
}

function renderCalendar() {
  $('#month-title').textContent = mesActual.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  const today = ymd(new Date());

  const html = celdasMes(mesActual.getFullYear(), mesActual.getMonth()).map((c) => {
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
  const rec = events.filter((e) => diasDe(e).length);
  if (!rec.length) {
    $('#schedule').innerHTML = '<div class="empty">Aún no tienes horario semanal.<br>Crea una clase o cita y marca “Se repite cada semana”.</div>';
    return;
  }
  let html = '';
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const list = rec.filter((e) => diasDe(e).includes(wd)).sort((a, b) => a.start_time.localeCompare(b.start_time));
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

const casillasDia = () => [...form.querySelectorAll('input[name="repeat_day"]')];

function marcarDias(dias) {
  casillasDia().forEach((c) => { c.checked = dias.includes(Number(c.value)); });
}

function actualizarRepeticion() {
  const repite = form.elements.repeat.checked;
  $('#repeat-days').classList.toggle('hidden', !repite);
  // Lo que se repite cada semana solo necesita el día en que empieza.
  if (repite) fechasElegidas = fechasElegidas.slice(0, 1);
  if (repite && !casillasDia().some((c) => c.checked) && fechasElegidas.length) {
    marcarDias([parseYmd(fechasElegidas[0]).getDay()]);
  }
  renderFechas();
}

/* ---------- Calendario de fechas del formulario ---------- */
let fechasElegidas = [];
let mesFechas = new Date();

function renderFechas() {
  const repite = form.elements.repeat.checked;
  const hoy = ymd(new Date());
  $('#fechas-label').textContent = repite ? 'Fecha de inicio' : 'Fechas';
  $('#fechas-ayuda').textContent = repite
    ? 'Elige el día en que empieza a repetirse.'
    : 'Toca cada día que quieras; tócalo otra vez para quitarlo. Todos tendrán el mismo horario.';
  $('#fechas-resumen').textContent = fechasElegidas.length ? resumenFechas(fechasElegidas) : 'Elegir fecha';
  $('#fechas-mes-titulo').textContent = mesFechas.toLocaleDateString('es', { month: 'long', year: 'numeric' });
  $('#fechas-cal').innerHTML = celdasMes(mesFechas.getFullYear(), mesFechas.getMonth()).map((c) => {
    const elegido = fechasElegidas.includes(c.date);
    const cls = ['cal-day', c.other && 'other', c.date === hoy && 'today', elegido && 'elegido'].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-fecha="${c.date}" aria-pressed="${elegido}">${c.num}</button>`;
  }).join('');
}

function abrirFechas(abierto) {
  $('#fechas-panel').classList.toggle('hidden', !abierto);
  $('#fechas-btn').setAttribute('aria-expanded', String(abierto));
}

function cambiarMesFechas(delta) {
  mesFechas = new Date(mesFechas.getFullYear(), mesFechas.getMonth() + delta, 1);
  renderFechas();
}

$('#fechas-btn').addEventListener('click', () => abrirFechas($('#fechas-panel').classList.contains('hidden')));
$('#fechas-listo').addEventListener('click', () => abrirFechas(false));
$('#fechas-prev').addEventListener('click', () => cambiarMesFechas(-1));
$('#fechas-next').addEventListener('click', () => cambiarMesFechas(1));
$('#fechas-limpiar').addEventListener('click', () => { fechasElegidas = []; renderFechas(); });
$('#fechas-cal').addEventListener('click', (e) => {
  const fecha = e.target.dataset.fecha;
  if (!fecha) return;
  if (form.elements.repeat.checked) fechasElegidas = [fecha];
  else if (fechasElegidas.includes(fecha)) fechasElegidas = fechasElegidas.filter((f) => f !== fecha);
  else fechasElegidas = [...fechasElegidas, fecha].sort();
  renderFechas();
});

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
    fechasElegidas = ev.specific_dates?.length ? [...ev.specific_dates] : [ev.event_date];
    el.start_time.value = hhmm(ev.start_time);
    el.end_time.value = hhmm(ev.end_time);
    el.remind.value = String(ev.remind_minutes);
    el.repeat.checked = diasDe(ev).length > 0;
    marcarDias(diasDe(ev));
    el.lugar.value = ev.location || '';
    el.notas.value = ev.notes || '';
    el.links.value = (ev.links || []).join('\n');
  } else {
    fechasElegidas = [ymd(new Date())];
  }
  mesFechas = fechasElegidas.length ? parseYmd(fechasElegidas[0]) : new Date();
  abrirFechas(false);
  actualizarRepeticion();
  renderExistingFiles();
  dlg.showModal();
}

$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-close').addEventListener('click', () => dlg.close());
$('#existing-files').addEventListener('click', (e) => {
  const i = e.target.dataset.rm;
  if (i === undefined) return;
  removedPaths.push(editingFiles[i].path);
  editingFiles.splice(Number(i), 1);
  renderExistingFiles();
});

form.elements.repeat.addEventListener('change', actualizarRepeticion);
$('#btn-lun-vie').addEventListener('click', () => marcarDias([1, 2, 3, 4, 5]));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = form.elements;
  const btn = $('#btn-save');
  btn.disabled = true; btn.textContent = 'Guardando…';

  try {
    if (!fechasElegidas.length) {
      abrirFechas(true);
      throw new Error('Elige al menos una fecha');
    }
    const dias = el.repeat.checked ? casillasDia().filter((c) => c.checked).map((c) => Number(c.value)) : [];
    if (el.repeat.checked && !dias.length) throw new Error('Elige al menos un día para repetir');

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
      event_date: fechasElegidas[0],
      specific_dates: fechasElegidas.length > 1 ? fechasElegidas : null,
      start_time: el.start_time.value,
      end_time: el.end_time.value || null,
      location: el.lugar.value.trim() || null,
      notes: el.notas.value.trim() || null,
      links,
      files,
      remind_minutes: Number(el.remind.value),
      recurring_days: dias.length ? dias : null,
      recurring_weekday: dias.length ? dias[0] : null,
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
    const variasFechas = ev.recurring_weekday != null || ev.specific_dates?.length;
    if (!confirm(`¿Eliminar "${ev.title}"?` + (variasFechas ? '\nSe borrarán todas sus fechas.' : ''))) return;
    const paths = (ev.files || []).map((f) => f.path);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    const { error } = await sb.from('events').delete().eq('id', delId);
    if (error) return toast(error.message);
    toast('Eliminado');
    load();
  }
});

/* ---------- Enlaces que abren la app instalada ---------- */
const APPS_REUNION = [
  { hosts: /(^|\.)zoom\.us$/i, paquete: 'us.zoom.videomeetings' },
  { hosts: /^meet\.google\.com$/i, paquete: 'com.google.android.apps.tachyon' },
  { hosts: /^teams\.(microsoft|live)\.com$/i, paquete: 'com.microsoft.teams' },
];

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-enlace]');
  if (!a) return;
  const url = new URL(a.href);
  const paquete = APPS_REUNION.find((app) => app.hosts.test(url.hostname))?.paquete;

  if (nativo) {
    e.preventDefault();
    nativo.abrirEnlace({ url: url.href, paquete }).catch(() => window.open(url.href, '_blank'));
  } else if (paquete && /android/i.test(navigator.userAgent)) {
    // Chrome abre la app si está instalada y, si no, sigue el enlace normal.
    e.preventDefault();
    location.href = `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${paquete};`
      + `S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
  }
});

/* ---------- Notificaciones push ---------- */
function urlB64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$('#btn-push').addEventListener('click', async () => {
  try {
    if (nativo) {
      await nativo.pedirPermisos();
      return toast('🔔 Los avisos por voz están activos en este celular');
    }
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
    toast('🔔 Notificaciones activadas en este dispositivo');
    lanzarAlerta({ key: `activado:${Date.now()}`, title: 'Notificaciones activadas', body: 'Listo, así te avisaré de tus recordatorios.' });
  } catch (err) {
    console.error(err);
    toast('No se pudo activar: ' + (err.message || err));
  }
});

/* ---------- Alertas: voz, sonido y vibración ---------- */
// En la app de Android la voz y la vibración las pone el celular (funcionan bloqueado).
const nativo = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins.AlarmasNativas : null;
const VIBRACION = [500, 200, 500, 200, 500, 200, 500];
const REVISION_MS = 30000;
const VENTANA_TRAS_INICIO_MS = 5 * 60000; // igual que la función send-reminders
const avisados = new Set();
const dlgAlerta = $('#dlg-alerta');
let audioCtx = null;
let textoAlerta = '';

function yaAvisado(key) {
  if (avisados.has(key)) return true;
  try { return localStorage.getItem(`aviso:${key}`) === '1'; } catch { return false; }
}

function marcarAvisado(key) {
  avisados.add(key);
  try { localStorage.setItem(`aviso:${key}`, '1'); } catch { /* sin almacenamiento: basta la memoria */ }
}

// Los navegadores exigen un toque previo para permitir audio: se prepara en el primero.
function prepararAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (err) {
    console.warn('Audio no disponible', err);
  }
}
document.addEventListener('click', prepararAudio, { capture: true });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Devuelve si llegó a sonar, para no tapar la voz con el tono.
async function sonar() {
  if (!audioCtx) return false;
  // Sin un toque previo resume() no termina nunca: se espera poco y se sigue sin sonido.
  await Promise.race([audioCtx.resume(), esperar(300)]);
  if (audioCtx.state !== 'running') return false;
  [880, 1175, 880].forEach((freq, i) => {
    const inicio = audioCtx.currentTime + i * 0.28;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, inicio);
    gain.gain.exponentialRampToValueAtTime(0.4, inicio + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(inicio);
    osc.stop(inicio + 0.26);
  });
  return true;
}

// La API de voz no indica el género: se reconoce por el nombre de la voz.
const VOZ_MUJER = /helena|laura|sabina|dalia|elvira|paloma|salom[eé]|elena|camila|catalina|francisca|paola|m[oó]nica|paulina|marisol|soledad|ximena|lupe|mar[ií]a|female|mujer|google espa[nñ]ol/i;
const VOZ_HOMBRE = /pablo|ra[uú]l|jorge|diego|juan|carlos|[aá]lvaro|gerardo|alex|tom[aá]s|enrique|andr[eé]s|\bmale\b|hombre/i;

function elegirVozMujer() {
  const voces = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('es'));
  const mujeres = voces.filter((v) => VOZ_MUJER.test(v.name) && !VOZ_HOMBRE.test(v.name));
  return mujeres.find((v) => /natural|online/i.test(v.name))
    ?? mujeres[0]
    ?? voces.find((v) => !VOZ_HOMBRE.test(v.name))
    ?? voces[0];
}

// El navegador carga las voces con retraso: sin esperar, usaría la voz por defecto.
async function vocesListas() {
  if (speechSynthesis.getVoices().length) return;
  await Promise.race([
    new Promise((r) => speechSynthesis.addEventListener('voiceschanged', r, { once: true })),
    esperar(1000),
  ]);
}

async function hablar(texto) {
  if (!('speechSynthesis' in window)) return;
  await vocesListas();
  const voz = new SpeechSynthesisUtterance(texto);
  voz.lang = 'es-ES';
  voz.rate = 0.95;
  voz.pitch = 1.1;
  const elegida = elegirVozMujer();
  if (elegida) { voz.voice = elegida; voz.lang = elegida.lang; }
  speechSynthesis.speak(voz);
}

let turnoAnuncio = 0;

async function anunciar(texto) {
  if (nativo) return; // la alarma del celular ya lo está diciendo
  const turno = turnoAnuncio; // solo callar() lo cambia; dos avisos seguidos se oyen en cola
  vibrar();
  if (await sonar()) await esperar(850);
  if (turno === turnoAnuncio) await hablar(texto);
}

function callar() {
  turnoAnuncio++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  navigator.vibrate?.(0);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

function vibrar() {
  // No existe en iPhone ni en la mayoría de PC: ahí simplemente no hace nada.
  try { navigator.vibrate?.(VIBRACION); } catch { /* sin soporte */ }
}

function lanzarAlerta({ key, title, body }, { notificarSistema = false } = {}) {
  if (yaAvisado(key)) return;
  marcarAvisado(key);

  textoAlerta = body;
  $('#alerta-titulo').textContent = title;
  $('#alerta-texto').textContent = body;
  if (!dlgAlerta.open) dlgAlerta.showModal();

  anunciar(textoAlerta);

  // Comparte etiqueta con el push: si llegan los dos, queda una sola notificación.
  if (!nativo && notificarSistema && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: VIBRACION,
      tag: key,
      requireInteraction: true,
      data: { type: 'reminder', key, title, body },
    })).catch(console.error);
  }
}

$('#alerta-escuchar').addEventListener('click', () => {
  if (nativo) return nativo.decir({ texto: textoAlerta }).catch(console.error);
  prepararAudio();
  callar();
  anunciar(textoAlerta);
});
$('#alerta-cerrar').addEventListener('click', () => {
  callar();
  dlgAlerta.close();
});

$('#btn-test-alert').addEventListener('click', () => {
  prepararAudio();
  const body = 'Hola, si me escuchas, tus avisos por voz ya están funcionando.';
  lanzarAlerta({ key: `prueba:${Date.now()}`, title: 'Prueba de alerta', body });
  nativo?.decir({ texto: body }).catch(console.error);
});

// Mismos textos que en supabase/functions/send-reminders/index.ts
function nombreEvento(ev) {
  const titulo = ev.title.trim();
  if (titulo.toLowerCase().startsWith(ev.kind)) return `tu ${titulo}`;
  return ev.kind === 'clase' ? `tu clase de ${titulo}` : `tu ${ev.kind}: ${titulo}`;
}

function duracion(mins) {
  const plural = (n, palabra) => `${n} ${palabra}${n === 1 ? '' : 's'}`;
  if (mins >= 1440 && mins % 1440 === 0) return plural(mins / 1440, 'día');
  const horas = Math.floor(mins / 60);
  const resto = mins % 60;
  if (!horas) return plural(resto, 'minuto');
  return resto ? `${plural(horas, 'hora')} y ${plural(resto, 'minuto')}` : plural(horas, 'hora');
}

function textoAviso(ev, msFaltantes) {
  const lugar = ev.location ? ` en ${ev.location}` : '';
  const nombre = nombreEvento(ev);
  return `Hola, te recuerdo con cariño que ${nombre} empieza en ${duracion(Math.ceil(msFaltantes / 60000))}, a las ${hhmm(ev.start_time)}${lugar}. Ve preparándote con calma.`;
}

function textoInicio(ev) {
  const lugar = ev.location ? ` en ${ev.location}` : '';
  const nombre = nombreEvento(ev);
  return `¡Ya es la hora! ${nombre[0].toUpperCase()}${nombre.slice(1)} empieza ahora${lugar}. Que te vaya muy bien.`;
}

// Mientras la página está abierta avisa por sí sola, aunque el push no llegue.
function revisarRecordatorios() {
  const ahora = new Date();
  const hoy = parseYmd(ymd(ahora));
  for (const ev of events) {
    if (ev.remind_minutes < 0) continue;
    for (const fecha of occurrences(ev, hoy, 1)) {
      const falta = new Date(`${fecha}T${ev.start_time}`).getTime() - ahora.getTime();
      if (falta > ev.remind_minutes * 60000 || falta <= -VENTANA_TRAS_INICIO_MS) continue;
      const etapa = falta > 0 ? 'aviso' : 'inicio';
      lanzarAlerta(
        { key: `${ev.id}:${fecha}:${etapa}`, title: ev.title, body: etapa === 'aviso' ? textoAviso(ev, falta) : textoInicio(ev) },
        { notificarSistema: true },
      );
    }
  }
}

// Le pasa al celular los avisos próximos, para que suenen aunque la app esté cerrada.
function sincronizarAlarmasNativas() {
  if (!nativo) return;
  const ahora = Date.now();
  const hoy = parseYmd(ymd(new Date()));
  const alarmas = [];
  for (const ev of events) {
    if (ev.remind_minutes < 0) continue;
    for (const fecha of occurrences(ev, hoy, HORIZONTE_DIAS)) {
      const inicio = new Date(`${fecha}T${ev.start_time}`).getTime();
      if (ev.remind_minutes > 0) {
        alarmas.push({ id: `${ev.id}:${fecha}:aviso`, at: inicio - ev.remind_minutes * 60000, title: ev.title, text: textoAviso(ev, ev.remind_minutes * 60000) });
      }
      alarmas.push({ id: `${ev.id}:${fecha}:inicio`, at: inicio, title: ev.title, text: textoInicio(ev) });
    }
  }
  nativo.programar({ alarmas: alarmas.filter((a) => a.at > ahora) }).catch(console.error);

  try {
    if (localStorage.getItem('permisos-pedidos') !== '1') {
      localStorage.setItem('permisos-pedidos', '1');
      nativo.pedirPermisos().catch(console.error);
    }
  } catch { /* sin almacenamiento: se pueden pedir con el botón 🔔 */ }
}

// Al volver a la app, trae lo que se haya cambiado desde la PC.
document.addEventListener('visibilitychange', () => {
  if (nativo && user && !document.hidden) load();
});

setInterval(() => {
  if (!user) return;
  revisarRecordatorios();
  renderAgenda(); // mantiene al día "EN CURSO" y "FINALIZADO"
}, REVISION_MS);

// El service worker avisa al recibir un push o al tocar la notificación.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'reminder') lanzarAlerta(e.data);
});

// App abierta desde una notificación estando cerrada.
{
  const params = new URLSearchParams(location.search);
  const key = params.get('alerta_key');
  if (key) {
    history.replaceState(null, '', location.pathname);
    avisados.delete(key);
    try { localStorage.removeItem(`aviso:${key}`); } catch { /* sin almacenamiento */ }
    lanzarAlerta({ key, title: params.get('alerta_titulo') || 'Mi Agenda', body: params.get('alerta_texto') || '' });
  }
}