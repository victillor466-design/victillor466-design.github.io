/* =====================================================================
 * IMEI VALIDADOR — app para PDA (lector con gatillo)
 * 1) Escanea el código de barras de la caja (EAN)
 * 2) Escanea el IMEI
 * Valida al instante con la lista del día descargada del Sheet.
 * Guarda las lecturas en la PDA y las envía al Sheet cuando hay señal.
 * ===================================================================== */

// ⬇️ PEGA AQUÍ LA URL DE TU WEB APP (Apps Script → Implementar → URL que termina en /exec)
const URL_POR_DEFECTO = 'https://script.google.com/macros/s/AKfycbyyDWMLVhbrQizrRdgP5zy18OHbZldgOaxEV9bbAhTCm6NpLs6szegwJayjwdKu0-ev/exec';

const CLAVES = {
  url: 'imei_url', auditor: 'imei_auditor', lote: 'imei_lote',
  datos: 'imei_datos', cola: 'imei_cola', historial: 'imei_historial'
};
const CADA_ENVIO_MS = 15000;      // intenta enviar cada 15 s
const CADA_LISTA_MS = 180000;     // refresca la lista cada 3 min

// ---------- Estado ----------
let indice = {
  imeis: new Map(),        // imeiNorm -> { codigo, imei, desc }
  barraACodigos: new Map(),// barraNorm -> Set(codigoNorm)
  codigosConImei: new Set(),
  tomados: new Map(),      // imeiNorm -> auditor (servidor + esta PDA)
  generado: null
};
let paso = 'caja';         // 'caja' | 'imei'
let cajaActual = null;     // { barra, codigos:Set, desc }
let enviando = false;

// ---------- Utilidades ----------
const $ = (id) => document.getElementById(id);
const leer = (k, def) => { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch (e) { return def; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio */ } };

function normalizar(valor) {
  return String(valor ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^0+(?=.)/, '');
}
function extraerImei(texto) {
  const quince = String(texto).match(/\d{15}/);
  return quince ? quince[0] : String(texto).trim();
}
function formatearImei(imei) {
  const s = String(imei);
  return s.length === 15 ? `${s.slice(0, 6)} ${s.slice(6, 12)} ${s.slice(12)}` : s;
}
function urlApi() { return leer(CLAVES.url, '') || URL_POR_DEFECTO; }
function apiLista() { return /^https:\/\/script\.google\.com\//.test(urlApi()); }
function nuevoId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function hora(ts) { return new Date(ts).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }); }

// ---------- Sonido y vibración ----------
let audio;
function sonar(tipo) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const tonos = tipo === 'ok' ? [[880, 0, .12]] : [[220, 0, .18], [180, .22, .25]];
    tonos.forEach(([f, ini, dur]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = 'square'; g.gain.value = .12;
      o.connect(g); g.connect(audio.destination);
      o.start(audio.currentTime + ini); o.stop(audio.currentTime + ini + dur);
    });
  } catch (e) { /* sin audio */ }
  if (navigator.vibrate) navigator.vibrate(tipo === 'ok' ? 60 : [120, 80, 200]);
}

// ---------- Datos del Sheet ----------
function construirIndice(datos) {
  const nuevo = { imeis: new Map(), barraACodigos: new Map(), codigosConImei: new Set(), tomados: new Map(), generado: datos.generado };
  (datos.imeis || []).forEach(([codigo, imei, desc]) => {
    const c = normalizar(codigo);
    nuevo.imeis.set(normalizar(imei), { codigo, imei, desc, codigoNorm: c });
    nuevo.codigosConImei.add(c);
  });
  (datos.maestro || []).forEach(([codigo, barra]) => {
    const b = normalizar(barra);
    if (!nuevo.barraACodigos.has(b)) nuevo.barraACodigos.set(b, new Set());
    nuevo.barraACodigos.get(b).add(normalizar(codigo));
  });
  (datos.tomados || []).forEach(([imei, auditor]) => nuevo.tomados.set(normalizar(imei), auditor));
  // Lo tomado en esta PDA que aún no llegó al Sheet también cuenta
  leer(CLAVES.cola, []).forEach((l) => nuevo.tomados.set(normalizar(l.imei), l.auditor));
  indice = nuevo;
}

async function actualizarLista(silencioso) {
  if (!apiLista()) { if (!silencioso) avisar('aviso', '⚙', 'Falta la URL del Sheet', 'Pídele a Viktor que la configure en Ajustes.'); return; }
  try {
    const r = await fetch(`${urlApi()}?accion=datos&t=${Date.now()}`, { cache: 'no-store' });
    const datos = await r.json();
    if (!datos.ok) throw new Error(datos.error || 'Respuesta inválida');
    guardar(CLAVES.datos, datos);
    construirIndice(datos);
    pintarInfoLista(); pintarPendientes();
    if (!silencioso) avisar('neutro', '↻', 'Lista actualizada', `${indice.imeis.size} IMEIs en la lista de hoy.`);
  } catch (e) {
    if (!silencioso) avisar('aviso', '⚠', 'No se pudo actualizar', 'Sin señal. Se usa la última lista descargada.');
  }
}

// ---------- Envío de lecturas ----------
async function enviarCola() {
  const cola = leer(CLAVES.cola, []);
  pintarEstadoEnvio();
  if (enviando || cola.length === 0 || !apiLista() || !navigator.onLine) return;
  enviando = true;
  try {
    const lote = cola.slice(0, 50);
    const r = await fetch(urlApi(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ lecturas: lote })
    });
    const res = await r.json();
    if (!res.ok) throw new Error(res.error);

    const listos = new Set([...(res.guardados || []), ...(res.duplicados || []).map((d) => d.id)]);
    guardar(CLAVES.cola, leer(CLAVES.cola, []).filter((l) => !listos.has(l.id)));

    if ((res.duplicados || []).length) {
      const hist = leer(CLAVES.historial, []);
      res.duplicados.forEach((d) => {
        const h = hist.find((x) => x.id === d.id);
        if (h) { h.duplicado = true; h.tomadoPor = d.tomadoPor; }
        indice.tomados.set(normalizar(d.imei), d.tomadoPor);
      });
      guardar(CLAVES.historial, hist);
      pintarHistorial();
      const d = res.duplicados[0];
      avisar('error', '✕', 'IMEI repetido', `${formatearImei(d.imei)} ya lo había tomado ${d.tomadoPor || 'otra PDA'}. No se contó dos veces.`);
      sonar('error');
    }
  } catch (e) { /* se reintenta luego */ }
  enviando = false;
  pintarEstadoEnvio();
  if (leer(CLAVES.cola, []).length > 0 && navigator.onLine) setTimeout(enviarCola, 1500);
}

// ---------- Flujo de escaneo ----------
function procesarLectura(texto) {
  const valor = String(texto).trim();
  if (!valor) return;
  if (!leer(CLAVES.auditor, '')) { mostrarVista('vistaAjustes'); avisar('aviso', '⚙', 'Escribe tu nombre', 'Antes de escanear, pon tu nombre en Ajustes.'); return; }
  if (indice.imeis.size === 0) { avisar('aviso', '⚠', 'No hay lista de IMEIs', 'Ve a Ajustes y toca "Actualizar lista".'); sonar('error'); return; }
  if (!leer(CLAVES.lote, '')) { avisar('aviso', '!', 'Escribe el lote', 'Pon el lote donde estás tomando (arriba) y vuelve a escanear.'); sonar('error'); $('lote').focus(); return; }
  paso === 'caja' ? procesarCaja(valor) : procesarImei(valor);
}

function procesarCaja(valor) {
  const barra = normalizar(valor);

  // Si escanearon un IMEI en vez de la caja, avisarles
  if (indice.imeis.has(normalizar(extraerImei(valor))) && !indice.barraACodigos.has(barra)) {
    avisar('error', '✕', 'Eso es un IMEI', 'Primero escanea el código de barras de la caja.'); sonar('error'); return;
  }

  let codigos = indice.barraACodigos.get(barra);
  if (!codigos && indice.codigosConImei.has(barra)) codigos = new Set([barra]); // escanearon el código de compra
  if (!codigos) {
    avisar('error', '✕', 'Código no encontrado', `${valor} no está en el Maestro. Escanea el código de barras de la caja.`); sonar('error'); return;
  }

  const conImei = [...codigos].filter((c) => indice.codigosConImei.has(c));
  if (conImei.length === 0) {
    avisar('aviso', '!', 'Sin IMEIs en la lista', 'Este producto no tiene IMEIs en la lista de hoy. Consúltalo con Viktor.'); sonar('error'); return;
  }

  const ejemplo = [...indice.imeis.values()].find((x) => conImei.includes(x.codigoNorm));
  cajaActual = { barra: valor, codigos: new Set(conImei), desc: ejemplo ? ejemplo.desc : '' };
  paso = 'imei';
  pintarRanuras();
  avisar('espera', '▤', 'Ahora escanea el IMEI', cajaActual.desc);
}

function procesarImei(valor) {
  // Primero tal cual (sirve para series con letras: TE2415S2..., PER26..., S3201KU...).
  // Si no está, prueba sacando solo los 15 dígitos (etiquetas tipo "IMEI:3567...").
  let imei = String(valor).trim();
  let info = indice.imeis.get(normalizar(imei));
  if (!info) {
    const quince = extraerImei(valor);
    if (indice.imeis.has(normalizar(quince))) { imei = quince; info = indice.imeis.get(normalizar(quince)); }
  }
  const imeiNorm = normalizar(info ? info.imei : imei);

  if (normalizar(valor) === normalizar(cajaActual.barra)) {
    avisar('error', '✕', 'Esa es la misma caja', 'Ahora escanea el IMEI del equipo.'); sonar('error'); return;
  }
  if (!info) {
    avisar('error', '✕', 'IMEI no está en la lista', `${formatearImei(imei)} no está en la lista. ¿Escaneaste el IMEI 2 u otro código? Escanea el IMEI 1 o la serie correcta.`); sonar('error'); return;
  }
  if (!cajaActual.codigos.has(info.codigoNorm)) {
    avisar('error', '✕', 'IMEI de otro producto', `Ese IMEI es de: ${info.desc}. Revisa que caja e IMEI sean del mismo equipo.`); sonar('error'); return;
  }
  if (indice.tomados.has(imeiNorm)) {
    avisar('error', '✕', 'Ya fue tomado', `${formatearImei(imei)} ya lo tomó ${indice.tomados.get(imeiNorm) || 'otra PDA'}. No lo cuentes dos veces.`);
    sonar('error'); reiniciarCaja(false); return;
  }

  const auditor = leer(CLAVES.auditor, '');
  const lectura = { id: nuevoId(), ean: cajaActual.barra, imei: info.imei, codigo: info.codigo, desc: info.desc, auditor, lote: leer(CLAVES.lote, ''), ts: Date.now() };
  guardar(CLAVES.cola, [...leer(CLAVES.cola, []), lectura]);
  guardar(CLAVES.historial, [lectura, ...leer(CLAVES.historial, [])].slice(0, 40));
  indice.tomados.set(imeiNorm, auditor);

  // Lista para la siguiente caja al instante (el gatillo puede seguir)
  reiniciarCaja(false);
  avisar('ok', '✓', 'Correcto', `${info.desc}\n${formatearImei(info.imei)}`);
  sonar('ok');
  pintarHistorial(); pintarPendientes();
  enviarCola();
}

function reiniciarCaja(limpiarMensaje) {
  paso = 'caja'; cajaActual = null;
  pintarRanuras();
  if (limpiarMensaje) avisar('neutro', '▤', 'Escanea la caja', 'Primero el código de barras de la caja, luego el IMEI.');
}

// ---------- Pintar pantalla ----------
function avisar(tipo, simbolo, titulo, detalle) {
  const r = $('resultado');
  r.className = `resultado ${tipo}`;
  $('resSimbolo').textContent = simbolo;
  $('resTitulo').textContent = titulo;
  $('resDetalle').textContent = detalle || '';
  $('resDetalle').style.whiteSpace = 'pre-line';
}

function pintarRanuras() {
  const enCaja = paso === 'caja';
  $('ranuraCaja').className = `ranura ${enCaja ? 'actual' : 'lista'}`;
  $('ranuraImei').className = `ranura ${enCaja ? '' : 'actual'}`;
  $('valorCaja').textContent = enCaja ? 'Escanea el código de barras' : cajaActual.barra;
  if (enCaja) $('valorImei').textContent = '—';
  else $('valorImei').textContent = 'Escanea el IMEI';
  $('lector').placeholder = enCaja ? 'Aprieta el gatillo: caja' : 'Aprieta el gatillo: IMEI';
  $('cambiarCaja').hidden = enCaja;
}

function pintarHistorial() {
  const lista = $('historial');
  const hist = leer(CLAVES.historial, []);
  lista.innerHTML = '';
  if (hist.length === 0) { lista.innerHTML = '<li class="h-meta">Aún no tomaste ningún IMEI.</li>'; return; }
  hist.slice(0, 15).forEach((h) => {
    const li = document.createElement('li');
    if (h.duplicado) li.className = 'duplicado';
    li.innerHTML = `<div class="h-imei"></div><div></div><div class="h-meta"></div>`;
    li.children[0].textContent = formatearImei(h.imei);
    li.children[1].textContent = h.desc || h.codigo;
    li.children[2].textContent = h.duplicado
      ? `Repetido: ya lo tenía ${h.tomadoPor || 'otra PDA'}`
      : `${hora(h.ts)}${h.lote ? ' · Lote ' + h.lote : ''}`;
    lista.appendChild(li);
  });
}

function pintarPendientes() {
  const filtro = normalizar($('buscarPendiente').value);
  const pendientes = [...indice.imeis.entries()].filter(([n]) => !indice.tomados.has(n)).map(([, v]) => v);
  const total = indice.imeis.size;
  $('resumenPendientes').textContent = total
    ? `Faltan ${pendientes.length} de ${total} IMEIs (${total - pendientes.length} tomados).`
    : 'Todavía no hay lista descargada.';

  const visibles = filtro
    ? pendientes.filter((p) => normalizar(p.imei).includes(filtro) || normalizar(p.codigo).includes(filtro) || normalizar(p.desc).includes(filtro))
    : pendientes;

  const grupos = new Map();
  visibles.forEach((p) => { if (!grupos.has(p.codigo)) grupos.set(p.codigo, { desc: p.desc, imeis: [] }); grupos.get(p.codigo).imeis.push(p.imei); });

  const cont = $('listaPendientes');
  cont.innerHTML = '';
  if (total && pendientes.length === 0) { cont.innerHTML = '<p class="info">Todos los IMEIs fueron tomados.</p>'; return; }
  let mostrados = 0;
  for (const [codigo, g] of grupos) {
    if (mostrados > 400) break;
    const div = document.createElement('div'); div.className = 'grupo';
    const h3 = document.createElement('h3'); h3.textContent = g.desc || codigo;
    const small = document.createElement('small'); small.textContent = `  ${codigo} · faltan ${g.imeis.length}`; h3.appendChild(small);
    const ul = document.createElement('ul');
    g.imeis.forEach((i) => { const li = document.createElement('li'); li.textContent = formatearImei(i); ul.appendChild(li); mostrados++; });
    div.append(h3, ul); cont.appendChild(div);
  }
}

function pintarEstadoEnvio() {
  const n = leer(CLAVES.cola, []).length;
  const b = $('estadoEnvio');
  b.classList.remove('pendiente', 'ok');
  if (!navigator.onLine) { b.textContent = n ? `Sin señal · ${n} por enviar` : 'Sin señal'; if (n) b.classList.add('pendiente'); }
  else if (n) { b.textContent = `${n} por enviar`; b.classList.add('pendiente'); }
  else { b.textContent = 'Todo enviado'; b.classList.add('ok'); }
}

function pintarInfoLista() {
  $('infoLista').textContent = indice.generado
    ? `Lista descargada ${hora(indice.generado)} · ${indice.imeis.size} IMEIs · ${indice.barraACodigos.size} códigos de barra.`
    : 'Lista sin descargar.';
}

function pintarQuien() {
  const a = leer(CLAVES.auditor, '');
  $('quienDonde').textContent = a ? `${a}  (tocar para cambiar)` : 'Toca aquí y escribe tu nombre';
  $('lote').value = leer(CLAVES.lote, '');
  $('cfgAuditor').value = a;
}

function mostrarVista(id) {
  document.querySelectorAll('.vista').forEach((v) => v.classList.toggle('activa', v.id === id));
  document.querySelectorAll('.pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.vista === id));
  if (id === 'vistaEscanear') enfocarLector();
  if (id === 'vistaPendientes') pintarPendientes();
  if (id === 'vistaAjustes') {
    $('cfgAuditor').value = leer(CLAVES.auditor, '');
    $('cfgUrl').value = leer(CLAVES.url, '');
  }
}

function enfocarLector() {
  if ($('vistaEscanear').classList.contains('activa')) $('lector').focus({ preventScroll: true });
}

// ---------- Eventos ----------
function iniciar() {
  const guardados = leer(CLAVES.datos, null);
  if (guardados) construirIndice(guardados);

  const lector = $('lector');
  lector.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const v = lector.value; lector.value = '';
      procesarLectura(v);
    }
  });
  // Mantener el foco en el lector para que el gatillo siempre escriba ahí
  lector.addEventListener('blur', () => setTimeout(() => {
    const otro = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && document.activeElement !== lector;
    if (!otro) enfocarLector();
  }, 250));

  $('teclado').addEventListener('click', () => {
    const manual = lector.getAttribute('inputmode') === 'none';
    lector.setAttribute('inputmode', manual ? 'text' : 'none');
    $('teclado').classList.toggle('activo', manual);
    lector.blur(); setTimeout(() => lector.focus(), 50);
  });

  $('cambiarCaja').addEventListener('click', () => { reiniciarCaja(true); enfocarLector(); });

  // Lote: se escribe arriba y queda fijo hasta que lo cambies
  const lote = $('lote');
  const guardarLote = () => { guardar(CLAVES.lote, lote.value.trim()); };
  lote.addEventListener('change', guardarLote);
  lote.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); guardarLote();
      avisar('neutro', '▤', `Lote ${lote.value.trim()}`, 'Ahora escanea la caja.');
      enfocarLector();
    }
  });

  document.querySelectorAll('.pestanas button').forEach((b) => b.addEventListener('click', () => mostrarVista(b.dataset.vista)));
  $('quienDonde').addEventListener('click', () => mostrarVista('vistaAjustes'));
  $('buscarPendiente').addEventListener('input', pintarPendientes);

  $('guardarAjustes').addEventListener('click', () => {
    guardar(CLAVES.auditor, $('cfgAuditor').value.trim());
    pintarQuien(); mostrarVista('vistaEscanear');
    avisar('neutro', '▤', 'Listo para escanear', 'Primero el código de barras de la caja, luego el IMEI.');
  });
  $('actualizarLista').addEventListener('click', () => actualizarLista(false));
  $('enviarAhora').addEventListener('click', enviarCola);
  $('guardarUrl').addEventListener('click', () => {
    guardar(CLAVES.url, $('cfgUrl').value.trim());
    actualizarLista(false);
  });
  $('borrarLocal').addEventListener('click', () => {
    const n = leer(CLAVES.cola, []).length;
    const msg = n ? `Hay ${n} lecturas SIN ENVIAR. Si borras, se pierden.\n\n¿Borrar de todas formas?` : '¿Borrar el historial de esta PDA?';
    if (confirm(msg)) { guardar(CLAVES.cola, []); guardar(CLAVES.historial, []); pintarHistorial(); pintarEstadoEnvio(); }
  });

  window.addEventListener('online', () => { pintarEstadoEnvio(); enviarCola(); actualizarLista(true); });
  window.addEventListener('offline', pintarEstadoEnvio);

  pintarQuien(); pintarRanuras(); pintarHistorial(); pintarInfoLista(); pintarEstadoEnvio();
  if (!leer(CLAVES.auditor, '')) mostrarVista('vistaAjustes'); else enfocarLector();

  actualizarLista(true);
  enviarCola();
  setInterval(enviarCola, CADA_ENVIO_MS);
  setInterval(() => actualizarLista(true), CADA_LISTA_MS);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', iniciar);
