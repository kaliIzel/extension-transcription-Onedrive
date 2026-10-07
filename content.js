(() => {
  "use strict";

  /* ============================================================
   * OnedriveTranscript - content.js
   * Extrae la transcripción completa del panel de Stream/OneDrive
   * (SharePoint) forzando la carga perezosa mediante auto-scroll
   * y entrega el texto agrupado por hablante y con marcas de
   * tiempo reducidas (solo cambios de hablante o cada 5 minutos).
   * ============================================================ */

  // --- Selectores específicos del panel de transcripción de Stream ---
  // Prioridad: atributos/data-test de Stream primero; los genéricos
  // van al final y siempre se validan contra marcas de tiempo para
  // no capturar listas ajenas ([role="listitem"] está prohibido).
  const SELECTORES_ESPECIFICOS = [
    '[data-testid="transcript-panel"]',
    '[data-testid="TranscriptPanel"]',
    '[data-testid="transcript"]',
    '[data-automation-id="transcript"]',
    '[data-automation-id="transcript-panel"]',
    '[class*="transcript-panel" i]',
    '[class*="transcriptpanel"]',
    '[class*="transcript__panel" i]',
    '[role="region"][aria-label*="transcript" i]',
    '[aria-label*="transcripción" i]',
    '[aria-label*="transcripcion" i]'
  ];

  const SELECTORES_GENERICOS = [
    '[class*="transcript" i]',
    '[class*="captions" i]',
    '[class*="subtitles" i]',
    '[class*="pane" i]'
  ];

  const REGEX_SOLO_MARCA = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?$/;
  const REGEX_MARCA_INICIO = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.*)$/;
  const REGEX_MARCAS = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
  // Líneas de la interfaz de Stream que no son transcripción
  const RUIDO_UI = /^(Descargar|Transcripción\.?|No tiene permiso para descargar|Use las teclas de dirección|El contenido generado por IA|Sincronizar con el v)/i;

  // Intervalo mínimo entre marcas de tiempo en la salida (5 minutos)
  const INTERVALO_MARCAS_SEG = 5 * 60;

  const TIEMPOS = {
    esperarPanelMs: 12000,
    intervaloScrollMs: 450, // solo método legado por texto
    limiteScrollMs: 240000, // 4 min de tope para el recorrido completo
    rondasEstables: 6, // solo método legado por texto
    esperaFinalMs: 800,
    asentarMinMs: 120, // el DOM debe estar quieto este tiempo antes de leer
    asentarMaxMs: 1800, // tope de espera por paso
    esperaInicialMs: 600
  };

  const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

  /* ------------------------------------------------------------
   * Utilidades de marcas de tiempo
   * ------------------------------------------------------------ */

  function marcaASegundos(marca) {
    if (!marca) return null;
    const partes = marca.split(":").map(Number);
    if (partes.some((n) => Number.isNaN(n))) return null;
    if (partes.length === 3) return partes[0] * 3600 + partes[1] * 60 + partes[2];
    if (partes.length === 2) return partes[0] * 60 + partes[1];
    return null;
  }

  function segundosAMarca(total) {
    const s = Math.max(0, Math.floor(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const g = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${p(h)}:${p(m)}:${p(g)}` : `${p(m)}:${p(g)}`;
  }

  /* ------------------------------------------------------------
   * Detección del panel de transcripción
   * ------------------------------------------------------------ */

  function contieneMarcas(texto, minimo) {
    const marcas = texto.match(REGEX_MARCAS);
    return marcas ? marcas.length >= minimo : false;
  }

  function esPanelValido(el, requiereMarcas) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    const texto = (el.innerText || "").trim();
    if (texto.length < 40) return false;
    if (requiereMarcas && !contieneMarcas(texto, 2)) return false;
    return true;
  }

  function puntuarCandidato(el) {
    const texto = (el.innerText || "").trim();
    if (texto.length < 40) return 0;
    const marcas = (texto.match(REGEX_MARCAS) || []).length;
    if (marcas < 2) return 0;
    // Prefiere paneles con muchas marcas y sin montones de texto ajeno
    return marcas * 1000 - texto.length * 0.01;
  }

  function encontrarPanelTranscripcion() {
    try {
      for (const sel of SELECTORES_ESPECIFICOS) {
        for (const el of document.querySelectorAll(sel)) {
          if (esPanelValido(el, false)) return el;
        }
      }

      // Fallback: regiones/paneles laterales puntuados por marcas de tiempo
      let mejor = null;
      let mejorPuntaje = 0;
      const candidatos = document.querySelectorAll(
        '[role="region"], aside, [role="complementary"], [class*="sidebar" i]'
      );
      for (const el of candidatos) {
        const puntaje = puntuarCandidato(el);
        if (puntaje > mejorPuntaje) {
          mejorPuntaje = puntaje;
          mejor = el;
        }
      }
      if (mejor && mejorPuntaje > 0) return mejor;

      // Último recurso: selectores genéricos SIEMPRE validados con marcas
      for (const sel of SELECTORES_GENERICOS) {
        for (const el of document.querySelectorAll(sel)) {
          if (esPanelValido(el, true)) return el;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async function esperarPanel(timeoutMs) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      const panel = encontrarPanelTranscripcion();
      if (panel) return panel;
      await dormir(400);
    }
    return null;
  }

  /* ------------------------------------------------------------
   * Auto-scroll progresivo (vence lazy-loading / virtualización)
   * ------------------------------------------------------------ */

  function encontrarScrollable(el) {
    let nodo = el;
    while (nodo && nodo !== document.documentElement) {
      const estilo = getComputedStyle(nodo);
      const desborda =
        /(auto|scroll|overlay)/.test(estilo.overflowY) &&
        nodo.scrollHeight > nodo.clientHeight + 8;
      if (desborda) return nodo;
      nodo = nodo.parentElement;
    }
    return null;
  }

  /**
   * Recorre el panel de arriba abajo en pasos progresivos, capturando
   * los segmentos en cada posición. Así se carga el texto perezoso y,
   * si la lista está virtualizada, no se pierde lo que se descarta del DOM.
   */
  async function cargarPorTextoLegado(panel) {
    const scrollEl = encontrarScrollable(panel) || panel;
    const segmentos = new Map(); // clave -> segmento (dedupe)

    const capturar = () => {
      try {
        // Usa tus funciones auxiliares existentes para mantener la compatibilidad
        fusionarSegmentos(segmentos, parsearSegmentos(panel.innerText || ""));
      } catch (_) {
        /* captura tolerante a fallos */
      }
    };

    let ultimoAlto = -1;
    let ultimoLargo = -1;
    let estable = 0;
    const inicio = Date.now();

    capturar(); // Posición inicial

    while (Date.now() - inicio < (TIEMPOS.limiteScrollMs || 180000)) {
      const altoVisible = scrollEl.clientHeight || 400;
      const altoTotal = scrollEl.scrollHeight || 0;
      const largoTexto = (panel.innerText || "").length;
      const enFinal = Math.ceil(scrollEl.scrollTop + altoVisible) >= altoTotal - 10;

      if (altoTotal > ultimoAlto || largoTexto > ultimoLargo) {
        ultimoAlto = altoTotal;
        ultimoLargo = largoTexto;
        estable = 0;
      } else {
        estable++;
        // Si llegamos al final y el texto no cambia tras varias rondas, terminamos
        if (enFinal && estable >= (TIEMPOS.rondasEstables || 5)) break;
        if (!enFinal && estable >= (TIEMPOS.rondasEstables || 5) * 4) break;
      }

      // SCROLL PROGRESIVO CORTO: Avanza en pasos fijos pequeños (220px) para evitar saltos
      scrollEl.scrollBy({
        top: 220,
        behavior: "smooth"
      });

      // Pausa leve para dar tiempo a React/FluentUI de renderizar los nodos en el DOM
      await dormir(TIEMPOS.intervaloScrollMs || 180);
      capturar();
    }

    // Remanente final
    try {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    } catch (_) { }
    await dormir(TIEMPOS.esperaFinalMs || 500);
    capturar();

    return Array.from(segmentos.values());
  }


  /* ------------------------------------------------------------
   * EXTRACCIÓN POR FILAS CON VERIFICACIÓN DE CONTINUIDAD
   * (estrategia principal contra la virtualización de la lista)
   *
   * Idea: en una lista virtualizada solo existen en el DOM las filas
   * visibles (+ un pequeño margen). Si entre dos "fotos" consecutivas
   * del DOM comparten al menos una fila, es matemáticamente imposible
   * que se haya saltado contenido entre ambas. Si no comparten ninguna,
   * se retrocede y se reduce el paso hasta recuperar el solape.
   * ------------------------------------------------------------ */

  const DEBUG = false; // true -> trazas en la consola de la página
  const log = (...args) => {
    if (DEBUG) console.debug("[OnedriveTranscript]", ...args);
  };

  const FRACCION_PASO = 0.6; // cada paso = 60 % de la altura visible (40 % de solape)
  const PASO_MINIMO_PX = 40;
  const HUECO_SOSPECHOSO_SEG = 180; // huecos > 3 min entre marcas se avisan

  const REGEX_HOJA_MARCA = /^\[?\d{1,2}:\d{2}(?::\d{2})?\]?$/;
  const REGEX_MARCA_EN_LINEA = /(?:^|\s)\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?(?=\s|$)/;
  const REGEX_AVATAR = /^[A-ZÁÉÍÓÚÑ]{1,3}$/;
  // "... 1 hora 3 minutos 53 segundos" (texto accesible oculto de Stream)
  const SUFIJO_ACCESIBLE =
    "\\d+\\s+(?:horas?|minutos?|segundos?)(?:\\s+\\d+\\s+(?:horas?|minutos?|segundos?))*";
  const REGEX_SUFIJO_ACCESIBLE = new RegExp("\\s+" + SUFIJO_ACCESIBLE + "\\s*$", "i");

  const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** "DA DIEGO FLORES ARO" -> "DIEGO FLORES ARO" (avatar con iniciales pegado al nombre). */
  function quitarInicialesInline(linea) {
    const m = linea.match(/^([A-ZÁÉÍÓÚÑ]{1,2})\s+(\S.*)$/);
    if (!m) return linea;
    const iniciales = m[1];
    const palabras = m[2].split(/\s+/);
    const inicial = (p) => (p[0] || "").toUpperCase();
    const coincide =
      iniciales[0] === inicial(palabras[0]) &&
      (iniciales.length === 1 || iniciales[1] === inicial(palabras[palabras.length - 1]));
    return coincide ? m[2] : linea;
  }

  /** Espera a que el DOM de `raiz` deje de mutar (o venza el tope). */
  function esperarAsentamiento(raiz, quietoMs, topeMs) {
    return new Promise((resolver) => {
      let temporizador = null;
      let tope = null;
      const observador = new MutationObserver(() => reiniciar());
      const fin = () => {
        observador.disconnect();
        clearTimeout(temporizador);
        clearTimeout(tope);
        resolver();
      };
      const reiniciar = () => {
        clearTimeout(temporizador);
        temporizador = setTimeout(fin, quietoMs);
      };
      observador.observe(raiz, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
      tope = setTimeout(fin, topeMs);
      reiniciar();
    });
  }

  function esScrollable(el) {
    try {
      const estilo = getComputedStyle(el);
      return (
        /(auto|scroll|overlay)/.test(estilo.overflowY) &&
        el.scrollHeight > el.clientHeight + 8
      );
    } catch (_) {
      return false;
    }
  }

  /** Hojas del DOM cuyo único contenido es una marca de tiempo (p. ej. "1:03:53"). */
  function hojasMarca(raiz) {
    const hojas = [];
    const recorrido = document.createTreeWalker(raiz, NodeFilter.SHOW_ELEMENT);
    let nodo;
    while ((nodo = recorrido.nextNode())) {
      if (nodo.children.length !== 0) continue;
      const t = (nodo.textContent || "").trim();
      if (t.length > 0 && t.length <= 10 && REGEX_HOJA_MARCA.test(t)) hojas.push(nodo);
    }
    return hojas;
  }

  /**
   * Busca el contenedor que REALMENTE hace scroll. Mira tanto los
   * descendientes como los ancestros del panel (la versión anterior solo
   * miraba hacia arriba y podía quedarse con un contenedor equivocado).
   * Gana el que contiene más marcas de tiempo; en empate, el más profundo.
   */
  function encontrarContenedorScroll(panel) {
    const candidatos = [];
    panel.querySelectorAll("*").forEach((el) => {
      if (esScrollable(el)) candidatos.push(el);
    });
    let nodo = panel;
    while (nodo && nodo !== document.documentElement) {
      if (esScrollable(nodo)) candidatos.push(nodo);
      nodo = nodo.parentElement;
    }

    let mejor = null;
    let mejorMarcas = -1;
    for (const el of candidatos) {
      const marcas = hojasMarca(el).length;
      if (marcas > mejorMarcas || (marcas === mejorMarcas && mejor && mejor.contains(el))) {
        mejor = el;
        mejorMarcas = marcas;
      }
    }
    return mejorMarcas > 0 ? mejor : null;
  }

  /**
   * Devuelve las filas (entradas) renderizadas ahora mismo. Fila = hijo
   * directo del ancestro común de todas las marcas que contiene a una marca.
   */
  function obtenerFilas(scrollEl) {
    const hojas = hojasMarca(scrollEl);
    if (hojas.length === 0) return [];

    if (hojas.length === 1) {
      let fila = hojas[0];
      let n = 0;
      while (fila.parentElement && fila.parentElement !== scrollEl && n < 8) {
        fila = fila.parentElement;
        n++;
      }
      return [fila];
    }

    let ancestro = hojas[0];
    for (const h of hojas) {
      while (ancestro && !ancestro.contains(h)) ancestro = ancestro.parentElement;
    }
    if (!ancestro) return [];

    const filas = new Set();
    for (const h of hojas) {
      let fila = h;
      while (fila.parentElement && fila.parentElement !== ancestro) fila = fila.parentElement;
      if (fila !== ancestro) filas.add(fila);
    }
    return Array.from(filas);
  }

  /** Convierte una fila del DOM en {marca, hablante, texto[]}. */
  function parsearFila(fila) {
    const lineas = String(fila.innerText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let iMarca = -1;
    let marca = null;
    for (let i = 0; i < Math.min(lineas.length, 4); i++) {
      const m = lineas[i].match(REGEX_MARCA_EN_LINEA);
      if (m) {
        iMarca = i;
        marca = m[1];
        break;
      }
    }
    if (iMarca < 0) return null;

    // Cabecera: avatar (iniciales) + nombre + marca (+ texto accesible oculto)
    let hablante = null;
    for (let i = 0; i <= iMarca; i++) {
      let l = lineas[i];
      if (i === iMarca) l = l.replace(REGEX_MARCA_EN_LINEA, " ");
      l = l.replace(REGEX_SUFIJO_ACCESIBLE, "").replace(/\s{2,}/g, " ").trim();
      if (!l || REGEX_AVATAR.test(l)) continue;
      l = quitarInicialesInline(l);
      if (!hablante && l.length <= 80) hablante = l;
    }

    // Cuerpo: se elimina únicamente "<hablante> N minutos M segundos"
    // (nunca se tocan frases habladas como "dame 5 minutos")
    const rxAccesible = hablante
      ? new RegExp(escaparRegex(hablante) + "\\s+" + SUFIJO_ACCESIBLE, "gi")
      : null;
    const texto = [];
    for (const original of lineas.slice(iMarca + 1)) {
      let l = rxAccesible ? original.replace(rxAccesible, " ") : original;
      l = l.replace(/\s{2,}/g, " ").trim();
      if (!l || (hablante && l === hablante)) continue;
      texto.push(l);
    }
    if (texto.length === 0) return null;

    return { marca, hablante, texto };
  }

  function claveFila(seg) {
    return `T:${seg.marca}|${seg.hablante || ""}|${seg.texto.join(" ").slice(0, 60)}`;
  }

  /** Lee todas las filas visibles y las acumula. Devuelve las claves vistas ahora. */
  function cosecharFilas(scrollEl, acumulado, contador) {
    const clavesAhora = new Set();
    for (const fila of obtenerFilas(scrollEl)) {
      let seg;
      try {
        seg = parsearFila(fila);
      } catch (_) {
        seg = null;
      }
      if (!seg) continue;
      const clave = claveFila(seg);
      clavesAhora.add(clave);
      const previo = acumulado.get(clave);
      if (!previo) {
        seg.orden = contador.n++;
        acumulado.set(clave, seg);
      } else if (seg.texto.join(" ").length > previo.texto.join(" ").length) {
        seg.orden = previo.orden;
        acumulado.set(clave, seg);
      }
    }
    return clavesAhora;
  }

  function ordenarSegmentos(lista) {
    return lista.sort((a, b) => {
      const sa = marcaASegundos(a.marca);
      const sb = marcaASegundos(b.marca);
      if (sa !== null && sb !== null && sa !== sb) return sa - sb;
      return (a.orden || 0) - (b.orden || 0);
    });
  }

  /**
   * Estrategia principal. Devuelve { segmentos, diagnostico }.
   * Si no logra identificar filas con marca de tiempo, cae al método
   * anterior basado en texto (cargarPorTextoLegado).
   */
  async function cargarTranscripcionCompleta(panel) {
    const scrollEl = encontrarContenedorScroll(panel);
    if (!scrollEl) {
      log("Sin contenedor de scroll con filas; uso método por texto");
      const segmentos = await cargarPorTextoLegado(panel);
      return { segmentos, diagnostico: { modo: "texto" } };
    }

    const asentar = () =>
      esperarAsentamiento(scrollEl, TIEMPOS.asentarMinMs, TIEMPOS.asentarMaxMs);
    const irA = (y) => scrollEl.scrollTo({ top: y, behavior: "instant" });
    const pasoIdeal = () =>
      Math.max(PASO_MINIMO_PX, Math.round((scrollEl.clientHeight || 400) * FRACCION_PASO));

    const acumulado = new Map();
    const contador = { n: 0 };
    const diag = {
      modo: "filas",
      pasos: 0,
      retrocesos: 0,
      saltosNoVerificados: 0,
      finAlcanzado: false
    };
    const inicio = Date.now();

    // 1) Ir al PRINCIPIO (la lista suele estar sincronizada con la posición del vídeo)
    for (let i = 0; i < 4; i++) {
      irA(0);
      await asentar();
      if (scrollEl.scrollTop <= 1) break;
    }
    await dormir(TIEMPOS.esperaInicialMs);

    let previas = cosecharFilas(scrollEl, acumulado, contador);
    if (previas.size === 0) {
      log("Sin filas legibles; uso método por texto");
      const segmentos = await cargarPorTextoLegado(panel);
      return { segmentos, diagnostico: { modo: "texto" } };
    }

    // 2) Descender con solape garantizado
    let paso = pasoIdeal();
    let finConfirmado = 0;
    let estancado = 0;

    while (Date.now() - inicio < TIEMPOS.limiteScrollMs) {
      const antes = scrollEl.scrollTop;
      const enFinal = antes + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;

      if (enFinal) {
        // Confirma el final: la lista puede crecer al medir alturas reales
        finConfirmado++;
        if (finConfirmado >= 3) {
          diag.finAlcanzado = true;
          break;
        }
        await asentar();
        previas = cosecharFilas(scrollEl, acumulado, contador);
        continue;
      }
      finConfirmado = 0;

      irA(antes + paso);
      await asentar();
      diag.pasos++;

      const movido = scrollEl.scrollTop - antes;
      const claves = cosecharFilas(scrollEl, acumulado, contador);

      let hayContinuidad = false;
      for (const k of claves) {
        if (previas.has(k)) {
          hayContinuidad = true;
          break;
        }
      }

      if (!hayContinuidad && movido > PASO_MINIMO_PX) {
        if (paso > PASO_MINIMO_PX) {
          // Posible salto: vuelve atrás y avanza con pasos más cortos
          diag.retrocesos++;
          paso = Math.max(PASO_MINIMO_PX, Math.floor(paso / 2));
          irA(antes);
          await asentar();
          previas = cosecharFilas(scrollEl, acumulado, contador);
          continue;
        }
        diag.saltosNoVerificados++;
      }

      if (movido <= 0) {
        estancado++;
        if (estancado >= 4) break;
      } else {
        estancado = 0;
      }

      previas = claves;
      paso = Math.min(pasoIdeal(), paso * 2); // recupera el paso normal gradualmente
    }

    // 3) Foto final al fondo
    irA(scrollEl.scrollHeight);
    await asentar();
    cosecharFilas(scrollEl, acumulado, contador);

    diag.duracionMs = Date.now() - inicio;
    log("Diagnóstico:", diag, "filas:", acumulado.size);

    return { segmentos: ordenarSegmentos(Array.from(acumulado.values())), diagnostico: diag };
  }

  /** Marcas consecutivas separadas por más de HUECO_SOSPECHOSO_SEG. */
  function detectarHuecos(segmentos) {
    const marcas = segmentos
      .map((s) => marcaASegundos(s.marca))
      .filter((n) => n !== null)
      .sort((a, b) => a - b);
    const huecos = [];
    for (let i = 1; i < marcas.length; i++) {
      if (marcas[i] - marcas[i - 1] > HUECO_SOSPECHOSO_SEG) {
        huecos.push({ desde: marcas[i - 1], hasta: marcas[i] });
      }
    }
    return huecos;
  }


  function claveSegmento(seg) {
    if (seg.marca) return `T:${seg.marca}:${seg.hablante || ""}`;
    return `S:${seg.hablante || ""}|${(seg.texto[0] || "").slice(0, 60)}`;
  }

  function fusionarSegmentos(mapa, nuevos) {
    for (const seg of nuevos) {
      const clave = claveSegmento(seg);
      const previo = mapa.get(clave);
      if (!previo) {
        mapa.set(clave, seg);
      } else {
        const largoPrevio = previo.texto.join(" ").length;
        const largoNuevo = seg.texto.join(" ").length;
        if (largoNuevo > largoPrevio) mapa.set(clave, seg);
      }
    }
  }

  /* ------------------------------------------------------------
   * Parseo del texto crudo del panel -> segmentos {marca, hablante, texto}
   * ------------------------------------------------------------ */

  function parsearSegmentos(textoCrudo) {
    const lineas = String(textoCrudo)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !RUIDO_UI.test(l));

    const segmentos = [];
    let actual = null;
    let esperandoHablante = false;

    const nuevoSegmento = (marca) => {
      actual = { marca: marca || null, hablante: null, texto: [] };
      segmentos.push(actual);
      esperandoHablante = true;
      return actual;
    };

    for (const linea of lineas) {
      const soloMarca = linea.match(REGEX_SOLO_MARCA);
      if (soloMarca) {
        nuevoSegmento(soloMarca[1]);
        continue;
      }

      const marcaInicio = linea.match(REGEX_MARCA_INICIO);
      if (marcaInicio) {
        nuevoSegmento(marcaInicio[1]);
        const resto = marcaInicio[2].trim();
        const hablante = resto.match(/^([^:]{1,60}):\s+(.*)$/);
        if (hablante) {
          actual.hablante = hablante[1].trim();
          actual.texto.push(hablante[2].trim());
          esperandoHablante = false;
        } else if (resto) {
          actual.texto.push(resto);
          esperandoHablante = false;
        }
        continue;
      }

      if (!actual) nuevoSegmento(null);

      // Tras una marca de tiempo suelta, la siguiente línea corta suele
      // ser el nombre del hablante
      if (
        esperandoHablante &&
        actual.texto.length === 0 &&
        linea.length <= 60 &&
        !/[.!?;]$/.test(linea)
      ) {
        actual.hablante = linea;
        esperandoHablante = false;
        continue;
      }
      esperandoHablante = false;

      if (!actual.hablante && actual.texto.length === 0) {
        const hablante = linea.match(/^([^:]{1,60}):\s+(.*)$/);
        if (hablante) {
          actual.hablante = hablante[1].trim();
          actual.texto.push(hablante[2].trim());
          continue;
        }
      }

      actual.texto.push(linea);
    }

    return segmentos.filter((s) => s.texto.join("").trim().length > 0);
  }

  /* ------------------------------------------------------------
   * Salida agrupada: párrafos por hablante, marcas cada 5 minutos
   * o en cada cambio de hablante (ahorro de tokens)
   * ------------------------------------------------------------ */

  function agruparParaTokens(segmentos) {
    const salida = [];
    let buffer = [];
    let ultimoHablante = null;
    let ultimaMarcaSeg = -Infinity;
    let marcaActual = null;

    const volcar = () => {
      if (buffer.length === 0) return;
      const etiqueta = [];
      if (marcaActual) etiqueta.push(`[${marcaActual}]`);
      if (ultimoHablante) etiqueta.push(`${ultimoHablante}:`);
      if (etiqueta.length > 0) salida.push(etiqueta.join(" "));
      salida.push(buffer.join(" "));
      salida.push("");
      buffer = [];
    };

    for (const seg of segmentos) {
      const segSeg = seg.marca ? marcaASegundos(seg.marca) : null;
      const hablante = seg.hablante || null;

      const cambioHablante =
        hablante !== null && ultimoHablante !== null && hablante !== ultimoHablante;
      const primeraVez = ultimoHablante === null && ultimaMarcaSeg === -Infinity;
      const saltoIntervalo =
        segSeg !== null &&
        (ultimaMarcaSeg === -Infinity ||
          segSeg - ultimaMarcaSeg >= INTERVALO_MARCAS_SEG ||
          segSeg < ultimaMarcaSeg);

      if (primeraVez || cambioHablante || saltoIntervalo) {
        volcar();
        ultimoHablante = hablante !== null ? hablante : ultimoHablante;
        marcaActual = seg.marca;
        ultimaMarcaSeg = segSeg !== null ? segSeg : ultimaMarcaSeg;
      } else if (segSeg !== null && segSeg > ultimaMarcaSeg) {
        ultimaMarcaSeg = segSeg;
      }

      buffer.push(seg.texto.join(" "));
    }

    volcar();
    return salida.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ------------------------------------------------------------
   * Verificación de cobertura: última marca vs duración del vídeo
   * ------------------------------------------------------------ */

  function obtenerDuracionVideo() {
    try {
      const video = document.querySelector("video");
      if (video && Number.isFinite(video.duration) && video.duration > 5) {
        return video.duration;
      }

      const slider = document.querySelector('[role="slider"][aria-valuemax]');
      if (slider) {
        const max = parseFloat(slider.getAttribute("aria-valuemax"));
        if (Number.isFinite(max) && max > 60 && max !== 100 && max <= 86400) {
          return max;
        }
        const valorTexto = slider.getAttribute("aria-valuetext");
        const seg = marcaASegundos((valorTexto || "").split("/").pop().trim());
        if (seg) return seg;
      }

      const re = /(\d{1,2}:)?\d{1,2}:\d{2}\s*\/\s*(\d{1,2}:)?\d{1,2}:\d{2}/;
      const candidatos = document.querySelectorAll(
        '[class*="time" i], [class*="duration" i], [class*="progress" i], [data-testid*="time" i]'
      );
      for (const el of candidatos) {
        const m = (el.innerText || "").match(re);
        if (m) {
          const total = marcaASegundos(m[0].split("/").pop().trim());
          if (total) return total;
        }
      }
    } catch (_) {
      /* la duración es opcional */
    }
    return null;
  }

  function verificarCobertura(segmentos, duracion) {
    let ultima = null;
    for (const seg of segmentos) {
      if (!seg.marca) continue;
      const s = marcaASegundos(seg.marca);
      if (s !== null && (ultima === null || s > ultima)) ultima = s;
    }

    if (duracion === null || ultima === null) {
      return { ultima, duracion, completa: null };
    }

    const umbral = Math.max(30, duracion * 0.05);
    return { ultima, duracion, completa: ultima >= duracion - umbral };
  }

  /* ------------------------------------------------------------
   * Metadatos (título/fecha/hora)
   * ------------------------------------------------------------ */

  const MESES_ES = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
    agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
  };
  const p2 = (n) => String(n).padStart(2, "0");

  function fechaValida(a, m, d) {
    return a >= 2000 && a <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  }

  function decodificarSeguro(texto) {
    try {
      return decodeURIComponent(texto);
    } catch (_) {
      return String(texto || "");
    }
  }

  /**
   * Fecha de la GRABACIÓN (no la de hoy). Fuentes, en orden:
   * 1) nombre del archivo con patrón AAAAMMDD_HHMMSS (título, URL o página)
   * 2) AAAAMMDD suelto en esas mismas fuentes
   * 3) fecha visible en la página: "21 de agosto de 2026"
   */
  function extraerFechaGrabacion(titulo) {
    const cuerpo = () => (document.body && document.body.innerText) || "";
    const fuentes = [
      ["titulo", document.title],
      ["url", decodificarSeguro(location.href)],
      ["titulo", titulo],
      ["pagina", cuerpo]
    ].map(([nombre, v]) => [nombre, v]);

    const texto = (v) => String(typeof v === "function" ? v() : v || "");

    for (const [nombre, v] of fuentes) {
      const m = texto(v).match(/(?<!\d)(20\d{2})(\d{2})(\d{2})[_\-T ](\d{2})(\d{2})(\d{2})(?!\d)/);
      if (m && fechaValida(+m[1], +m[2], +m[3])) {
        return { a: +m[1], m: +m[2], d: +m[3], h: `${m[4]}:${m[5]}:${m[6]}`, fuente: nombre };
      }
    }
    for (const [nombre, v] of fuentes) {
      const m = texto(v).match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
      if (m && fechaValida(+m[1], +m[2], +m[3])) {
        return { a: +m[1], m: +m[2], d: +m[3], h: null, fuente: nombre };
      }
    }
    const t = texto(cuerpo).match(/(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(20\d{2})/i);
    if (t) {
      const mes = MESES_ES[t[2].toLowerCase()];
      if (mes && fechaValida(+t[3], mes, +t[1])) {
        return { a: +t[3], m: mes, d: +t[1], h: null, fuente: "pagina" };
      }
    }
    return null;
  }

  function obtenerMetadatos() {
    const elTitulo =
      document.querySelector('[data-automation-id="file-name"], h1') ||
      null;
    const titulo = elTitulo
      ? elTitulo.innerText.trim()
      : document.title || "Transcripción";

    const ahora = new Date();
    let fecha = ahora.toLocaleDateString("es-BO");
    let hora = ahora.toLocaleTimeString("es-BO", { hour12: false });
    let fechaISO = `${ahora.getFullYear()}-${p2(ahora.getMonth() + 1)}-${p2(ahora.getDate())}`;
    let fechaArchivo = fechaISO.replace(/-/g, "");
    let fuenteFecha = "hoy";

    const f = extraerFechaGrabacion(titulo);
    if (f) {
      fecha = `${p2(f.d)}/${p2(f.m)}/${f.a}`;
      if (f.h) hora = f.h;
      fechaISO = `${f.a}-${p2(f.m)}-${p2(f.d)}`;
      fechaArchivo = `${f.a}${p2(f.m)}${p2(f.d)}`; // p. ej. 20260821
      fuenteFecha = f.fuente;
    }

    return { titulo, fecha, hora, fechaISO, fechaArchivo, fuenteFecha };
  }

  /* ------------------------------------------------------------
   * Proceso principal
   * ------------------------------------------------------------ */

  async function procesarExtraccion() {
    const panel = await esperarPanel(TIEMPOS.esperarPanelMs);
    if (!panel) {
      return {
        exito: false,
        error:
          "No se encontró el panel de transcripción. Abre el botón 'Transcripción' " +
          "en la barra derecha de Stream y vuelve a intentarlo."
      };
    }

    const { segmentos, diagnostico } = await cargarTranscripcionCompleta(panel);
    if (segmentos.length === 0) {
      return {
        exito: false,
        error:
          "El panel está abierto pero no se pudo extraer texto. " +
          "Reproduce un tramo del vídeo para que se genere la transcripción e inténtalo de nuevo."
      };
    }

    const transcripcion = agruparParaTokens(segmentos);
    if (!transcripcion) {
      return { exito: false, error: "La transcripción extraída está vacía." };
    }

    const duracion = obtenerDuracionVideo();
    const cobertura = verificarCobertura(segmentos, duracion);

    const avisos = [];
    if (cobertura.completa === false) {
      avisos.push(
        `Transcripción aparentemente incompleta: última marca ` +
          `${segundosAMarca(cobertura.ultima)} de ${segundosAMarca(cobertura.duracion)} de vídeo. ` +
          `Vuelve a pulsar "Obtener transcripción" para reintentar la carga completa.`
      );
    }
    const huecos = detectarHuecos(segmentos);
    if (huecos.length > 0) {
      const h = huecos[0];
      avisos.push(
        `Se detectaron ${huecos.length} hueco(s) de más de 3 min entre marcas ` +
          `(p. ej. ${segundosAMarca(h.desde)} → ${segundosAMarca(h.hasta)}). ` +
          `Pueden ser silencios reales o contenido no cargado.`
      );
    }
    if (diagnostico.saltosNoVerificados > 0) {
      avisos.push(
        `${diagnostico.saltosNoVerificados} avance(s) no pudieron verificarse; revisa la cobertura.`
      );
    }
    const advertencia = avisos.length > 0 ? avisos.join(" ") : null;

    return {
      exito: true,
      metadatos: obtenerMetadatos(),
      transcripcion,
      stats: {
        segmentos: segmentos.length,
        caracteres: transcripcion.length,
        ultimaMarcaSegundos: cobertura.ultima,
        duracionSegundos: cobertura.duracion,
        coberturaCompleta: cobertura.completa,
        huecos: huecos.length,
        modoExtraccion: diagnostico.modo,
        pasos: diagnostico.pasos || 0,
        retrocesos: diagnostico.retrocesos || 0
      },
      advertencia
    };
  }

  /* ------------------------------------------------------------
   * Listener de mensajes (respuesta asíncrona con return true)
   * ------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== "EXTRAER_DATOS") return false;

    (async () => {
      try {
        const resultado = await procesarExtraccion();
        sendResponse(resultado);
      } catch (error) {
        sendResponse({
          exito: false,
          error: `Error durante la extracción: ${error && error.message ? error.message : error}`
        });
      }
    })();

    return true; // mantiene el canal abierto mientras hay scroll en curso
  });
})();