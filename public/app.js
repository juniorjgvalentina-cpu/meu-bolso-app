// Meu Bolso - funcoes compartilhadas por todas as telas:
// 1) bloqueio de zoom (pinca e toque duplo) e tamanho de letra fixo no Android;
// 2) botao voltar passo a passo (volta pra tela/aba anterior, nao pra Home);
// 3) tela "Faturas do cartao" (faturas futuras + parcelas de antes do app).
(function () {
  // ---------- 1) Zoom ----------
  const estiloBase = document.createElement('style');
  estiloBase.textContent = `
    html{ -webkit-text-size-adjust:100%; text-size-adjust:100%; }
  `;
  document.head.appendChild(estiloBase);

  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let ultimoToque = 0;
  document.addEventListener('touchend', e => {
    const agora = Date.now();
    const alvo = e.target;
    const ehCampo = alvo && alvo.closest && alvo.closest('input, textarea, select');
    if (!ehCampo && agora - ultimoToque < 300) e.preventDefault();
    ultimoToque = agora;
  }, { passive: false });

  // ---------- 2) Voltar passo a passo ----------
  // "Camadas" sao coisas abertas por cima da tela (aba, painel, detalhe).
  // Cada uma vira um passo no historico: o botao voltar (do app, do Android
  // ou o gesto do iPhone) fecha a camada antes de sair da tela.
  const camadas = [];
  let ignorarProximoPop = false;

  window.addEventListener('popstate', (e) => {
    if (ignorarProximoPop) { ignorarProximoPop = false; return; }
    const fechar = camadas.pop();
    if (fechar) { fechar(); return; }
    // Passo antigo de uma camada que nao existe mais (ex: depois de
    // atualizar a tela) - pula direto pro passo anterior.
    if (e.state && e.state.mbCamada) history.back();
  });

  const MB = window.MB = window.MB || {};

  MB.abrirCamada = function (fechar, estadoExtra) {
    camadas.push(fechar);
    history.pushState(Object.assign({ mbCamada: camadas.length }, estadoExtra || {}), '');
  };

  // Fecha a camada de cima (como se apertasse voltar).
  MB.fecharCamada = function () {
    if (camadas.length) history.back();
  };

  MB.temCamadaAberta = () => camadas.length > 0;

  // A tela abriu ja num passo do historico (ex: voltou pra Planilha estando
  // na aba A Pagar) - registra como fechar esse passo.
  MB.adotarCamada = function (fechar) {
    camadas.push(fechar);
  };

  MB.voltar = function (telaPadrao) {
    if (camadas.length) { history.back(); return; }
    let veioDoApp = false;
    try { veioDoApp = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) {}
    if (veioDoApp && history.length > 1) history.back();
    else location.href = telaPadrao || '/home.html';
  };

  // ---------- 3) Faturas do cartao ----------
  const NOMES_MES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  function moeda(v) {
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function numero(texto) {
    if (texto === undefined || texto === null) return NaN;
    let s = String(texto).trim().replace(/[R$\s]/g, '');
    if (!s) return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    return Number(s);
  }
  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
  }
  function dataCurta(iso) {
    const s = String(iso).slice(0, 10);
    return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  }
  function mesCurto(ref) {
    const [a, m] = ref.split('-');
    return `${NOMES_MES_CURTO[Number(m) - 1]}/${a}`;
  }

  const css = `
  .mbf-overlay{ position:fixed; inset:0; background:#fff; z-index:60; display:flex; flex-direction:column;
    padding-top:env(safe-area-inset-top); padding-bottom:env(safe-area-inset-bottom); }
  .mbf-top{ display:flex; align-items:center; gap:8px; padding:14px 20px 10px; max-width:460px; margin:0 auto; width:100%; flex-shrink:0; }
  .mbf-top h2{ flex:1; text-align:center; font-family:'Sora',sans-serif; font-weight:800; font-size:16px; color:var(--ink,#16261F); }
  .mbf-btn-top{ width:38px; height:38px; border-radius:11px; border:1.5px solid var(--ink,#16261F); background:#fff;
    display:flex; align-items:center; justify-content:center; font-size:16px; color:var(--ink-soft,#3C4B43); flex-shrink:0; }
  .mbf-corpo{ flex:1; overflow-y:auto; overscroll-behavior:contain; max-width:460px; margin:0 auto; width:100%;
    padding:4px 20px 28px; display:flex; flex-direction:column; gap:10px; min-height:0; }
  .mbf-chips{ display:flex; gap:6px; flex-wrap:wrap; }
  .mbf-chip{ padding:8px 12px; border-radius:100px; border:1.5px solid var(--ink,#16261F); background:#fff;
    font-family:'Sora',sans-serif; font-weight:700; font-size:12px; color:var(--ink-soft,#3C4B43); }
  .mbf-chip.ativo{ background:var(--fixo,#2F6FED); border-color:var(--fixo,#2F6FED); color:#fff; }
  .mbf-info{ font-size:12px; color:var(--ink-soft,#3C4B43); line-height:1.5; background:var(--paper-dim,#F0ECE1);
    border-radius:12px; padding:11px 13px; }
  .mbf-mes{ border:1.5px solid var(--ink,#16261F); border-radius:14px; padding:12px 13px; display:flex; flex-direction:column; gap:6px; }
  .mbf-mes.fechada{ border-color:var(--imprevisto,#D64545); background:#FBEAEA; }
  .mbf-mes.aberta{ border-color:var(--fixo,#2F6FED); background:#EEF3FE; }
  .mbf-mes-topo{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .mbf-mes-nome{ font-family:'Sora',sans-serif; font-weight:800; font-size:13.5px; color:var(--ink,#16261F); }
  .mbf-mes-sub{ font-size:11px; color:var(--ink-soft,#3C4B43); margin-top:1px; }
  .mbf-mes-total{ font-family:'JetBrains Mono',monospace; font-weight:700; font-size:16px; color:var(--ink,#16261F); white-space:nowrap; }
  .mbf-badge{ font-size:9.5px; font-weight:800; letter-spacing:.04em; padding:2px 7px; border-radius:100px; display:inline-block; margin-top:3px; }
  .mbf-badge.fechada{ background:var(--imprevisto,#D64545); color:#fff; }
  .mbf-badge.aberta{ background:var(--fixo,#2F6FED); color:#fff; }
  .mbf-badge.futura{ background:var(--paper-dim,#F0ECE1); color:var(--ink-soft,#3C4B43); }
  .mbf-itens{ display:none; flex-direction:column; gap:5px; border-top:1.5px dashed var(--line,#E4DFD1); padding-top:8px; }
  .mbf-mes.aberto .mbf-itens{ display:flex; }
  .mbf-item{ display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--ink,#16261F); }
  .mbf-item span:first-child{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mbf-item span:last-child{ font-family:'JetBrains Mono',monospace; font-weight:600; white-space:nowrap; }
  .mbf-item.antigo{ color:var(--ink-soft,#3C4B43); font-style:italic; }
  .mbf-ver-itens{ font-size:11.5px; font-weight:700; color:var(--accent-dark,#C64F1E); align-self:flex-start; }
  .mbf-linha{ display:flex; align-items:center; gap:10px; min-width:0; border:1.5px solid var(--line,#E4DFD1); border-radius:12px; padding:9px 11px; }
  .mbf-linha label{ flex:1; min-width:0; font-family:'Sora',sans-serif; font-weight:700; font-size:13px; color:var(--ink,#16261F); }
  .mbf-linha label small{ display:block; font-family:-apple-system,sans-serif; font-weight:500; font-size:11px; color:var(--ink-soft,#3C4B43); }
  .mbf-linha input{ width:120px; max-width:46%; flex-shrink:0; text-align:right; border:1.5px solid var(--ink,#16261F); border-radius:10px;
    padding:9px 10px; font-size:15px; font-family:'JetBrains Mono',monospace; background:#fff; color:var(--ink,#16261F); min-width:0; }
  .mbf-repetir{ display:flex; flex-direction:column; gap:8px; border:1.5px dashed var(--fixo,#2F6FED); border-radius:12px; padding:11px; }
  .mbf-repetir .titulo{ font-size:12px; font-weight:700; color:var(--ink,#16261F); }
  .mbf-repetir .campos{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .mbf-repetir input{ flex:1; min-width:0; border:1.5px solid var(--ink,#16261F); border-radius:10px; padding:9px 10px; font-size:15px; background:#fff; color:var(--ink,#16261F); }
  .mbf-repetir select{ border:1.5px solid var(--ink,#16261F); border-radius:10px; padding:9px 8px; font-size:14px; background:#fff; color:var(--ink,#16261F); }
  .mbf-repetir button{ border:none; background:var(--fixo,#2F6FED); color:#fff; border-radius:10px; padding:10px 12px; font-weight:700; font-size:12.5px; }
  .mbf-botao{ border:1.5px solid var(--ink,#16261F); border-radius:13px; padding:13px; text-align:center; font-family:'Sora',sans-serif;
    font-weight:800; font-size:13.5px; background:var(--ink,#16261F); color:#fff; width:100%; }
  .mbf-botao.secundario{ background:#fff; color:var(--ink-soft,#3C4B43); }
  .mbf-botao:disabled{ opacity:.5; }
  .mbf-vazio{ text-align:center; color:var(--ink-soft,#3C4B43); font-size:12.5px; padding:20px 10px; }
  .mbf-erro{ background:#FBEAEA; color:var(--erro,#D64545); font-size:12.5px; font-weight:600; padding:10px 14px; border-radius:10px; display:none; }
  .mbf-soma{ font-size:12px; color:var(--ink-soft,#3C4B43); text-align:right; }
  `;

  let estado = null; // { cartaoId, modo, cartoes, dados, aoFechar }

  function garantirEstrutura() {
    if (document.getElementById('mbfOverlay')) return;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    const div = document.createElement('div');
    div.className = 'mbf-overlay';
    div.id = 'mbfOverlay';
    div.style.display = 'none';
    div.innerHTML = `
      <div class="mbf-top">
        <div class="mbf-btn-top" onclick="MB.fecharCamada()">←</div>
        <h2 id="mbfTitulo">Faturas do cartão</h2>
        <div class="mbf-btn-top" onclick="MB.recarregarFaturas()">🔄</div>
      </div>
      <div class="mbf-corpo" id="mbfCorpo"></div>
    `;
    document.body.appendChild(div);
  }

  function token() { return localStorage.getItem('meubolso_token'); }

  async function api(caminho, opcoes) {
    const res = await fetch('/api' + caminho, Object.assign({}, opcoes, {
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-token': token() }, (opcoes && opcoes.headers) || {})
    }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || 'Não foi possível carregar.');
    return data;
  }

  function erro(msg) {
    const el = document.getElementById('mbfErro');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 4500);
  }

  // Abre a tela de faturas. modo: 'ver' (faturas futuras) ou 'cadastro'
  // (logo depois de cadastrar o cartao: pergunta as parcelas de antes).
  MB.abrirFaturas = async function (cartaoId, opcoes) {
    opcoes = opcoes || {};
    garantirEstrutura();
    estado = { cartaoId: cartaoId || null, modo: opcoes.modo || 'ver', cartoes: [], dados: null, aoFechar: opcoes.aoFechar || null, mudou: false };
    const overlay = document.getElementById('mbfOverlay');
    overlay.style.display = 'flex';
    document.getElementById('mbfCorpo').innerHTML = '<div class="mbf-vazio">Carregando...</div>';
    MB.abrirCamada(() => {
      overlay.style.display = 'none';
      const cb = estado && estado.aoFechar;
      const mudou = estado && estado.mudou;
      estado = null;
      if (cb) cb(mudou);
    });
    await carregar();
  };

  MB.recarregarFaturas = () => { if (estado) carregar(); };

  async function carregar() {
    try {
      const lista = await api('/cartoes');
      estado.cartoes = lista.cartoes || [];
      if (!estado.cartoes.length) {
        document.getElementById('mbfTitulo').textContent = 'Faturas do cartão';
        document.getElementById('mbfCorpo').innerHTML = '<div class="mbf-vazio">Você ainda não cadastrou nenhum cartão. Cadastre em Configurações › Meus cartões, ou na hora de lançar um gasto no crédito.</div>';
        return;
      }
      if (!estado.cartaoId || !estado.cartoes.find(c => c.id === estado.cartaoId)) estado.cartaoId = estado.cartoes[0].id;
      estado.dados = await api(`/cartoes/${estado.cartaoId}/faturas`);
      desenhar();
    } catch (e) {
      document.getElementById('mbfCorpo').innerHTML = `<div class="mbf-vazio">${esc(e.message)}</div>`;
    }
  }

  MB._trocarCartao = function (id) {
    estado.cartaoId = id;
    if (estado.modo === 'editar') estado.modo = 'ver';
    document.getElementById('mbfCorpo').innerHTML = '<div class="mbf-vazio">Carregando...</div>';
    carregar();
  };

  MB._modoFaturas = function (modo) {
    estado.modo = modo;
    desenhar();
  };

  MB._abrirMes = function (ref) {
    const el = document.getElementById('mbfMes' + ref);
    if (el) el.classList.toggle('aberto');
  };

  function chipsCartoes() {
    if (estado.cartoes.length < 2) return '';
    return `<div class="mbf-chips">${estado.cartoes.map(c =>
      `<div class="mbf-chip ${c.id === estado.cartaoId ? 'ativo' : ''}" onclick="MB._trocarCartao(${c.id})">💳 ${esc(c.nome)}</div>`
    ).join('')}</div>`;
  }

  function desenhar() {
    const d = estado.dados;
    const corpo = document.getElementById('mbfCorpo');
    corpo.scrollTop = 0;
    document.getElementById('mbfTitulo').textContent = estado.modo === 'ver' ? 'Faturas do cartão' : 'Parcelas de antes do app';

    if (estado.modo === 'ver') {
      const meses = d.meses;
      const ultimoComValor = meses.reduce((idx, m, i) => (m.total > 0 ? i : idx), -1);
      const visiveis = meses.filter((m, i) => m.situacao !== 'futura' || i <= Math.max(ultimoComValor, 0) || i < 6);
      const totalFuturo = meses.filter(m => m.situacao === 'futura').reduce((s, m) => s + m.total, 0);
      corpo.innerHTML = `
        <div class="mbf-erro" id="mbfErro"></div>
        ${chipsCartoes()}
        <div class="mbf-info">💳 <b>${esc(d.cartao.nome)}</b> · fecha dia ${d.cartao.dia_fechamento} · vence dia ${d.cartao.dia_vencimento}<br>
          Aqui aparecem as faturas dos próximos meses com as parcelas que já vão cair nelas. Em "A Pagar" fica só a fatura de agora — a próxima entra lá sozinha quando essa fechar.</div>
        ${visiveis.map(m => {
          const rotulo = m.situacao === 'fechada' ? 'FECHADA · A PAGAR' : (m.situacao === 'aberta' ? 'ABERTA AGORA' : 'FUTURA');
          const temDetalhe = m.itens.length > 0 || m.valor_inicial > 0;
          return `
            <div class="mbf-mes ${m.situacao}" id="mbfMes${m.referencia}">
              <div class="mbf-mes-topo" ${temDetalhe ? `onclick="MB._abrirMes('${m.referencia}')"` : ''}>
                <div>
                  <div class="mbf-mes-nome">${esc(m.nome_mes)}</div>
                  <div class="mbf-mes-sub">vence ${dataCurta(m.data_vencimento)} · fecha ${dataCurta(m.data_fechamento)}</div>
                  <span class="mbf-badge ${m.situacao}">${rotulo}</span>
                </div>
                <div class="mbf-mes-total">${moeda(m.total)}</div>
              </div>
              ${temDetalhe ? `<div class="mbf-ver-itens" onclick="MB._abrirMes('${m.referencia}')">Ver o que tem nessa fatura ›</div>` : ''}
              <div class="mbf-itens">
                ${m.valor_inicial > 0 ? `<div class="mbf-item antigo"><span>Parcelas de antes do app</span><span>${moeda(m.valor_inicial)}</span></div>` : ''}
                ${m.itens.map(l => `<div class="mbf-item"><span>${esc(l.descricao)}${l.total_parcelas ? ` (${l.parcela_atual}/${l.total_parcelas})` : ''}</span><span>${moeda(l.valor)}</span></div>`).join('')}
              </div>
            </div>`;
        }).join('')}
        ${totalFuturo > 0 ? `<div class="mbf-soma">Total já comprometido nas próximas faturas: <b>${moeda(totalFuturo)}</b></div>` : ''}
        <button class="mbf-botao secundario" onclick="MB._modoFaturas('editar')">✎ Ajustar parcelas de antes do app</button>
      `;
      return;
    }

    // modo cadastro / editar: um campo por mes
    const editaveis = d.meses.filter(m => !m.inicial_paga).slice(0, 13);
    const ehCadastro = estado.modo === 'cadastro';
    corpo.innerHTML = `
      <div class="mbf-erro" id="mbfErro"></div>
      ${ehCadastro ? '' : chipsCartoes()}
      <div class="mbf-info">${ehCadastro
        ? `💳 <b>${esc(d.cartao.nome)}</b> cadastrado!<br>Esse cartão já tem compras parceladas de antes de você usar o app? Coloque abaixo quanto <b>já está em cada fatura</b> (dá pra ver no app do banco). Assim as compras que você lançar aqui já somam em cima, mês a mês, e você não precisa ficar atualizando.`
        : `Quanto <b>já estava em cada fatura</b> do <b>${esc(d.cartao.nome)}</b> antes de você começar a usar o app. As compras lançadas aqui somam em cima. Deixe em branco os meses sem nada.`}</div>
      <div class="mbf-repetir">
        <div class="titulo">Atalho: mesma parcela por vários meses</div>
        <div class="campos">
          <input type="text" inputmode="decimal" id="mbfRepValor" placeholder="Valor (ex: 250,00)">
          <select id="mbfRepMeses">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1} ${i ? 'meses' : 'mês'}</option>`).join('')}</select>
          <button type="button" onclick="MB._repetirValor()">Somar</button>
        </div>
      </div>
      ${editaveis.map(m => `
        <div class="mbf-linha">
          <label>${mesCurto(m.referencia)}<small>${m.situacao === 'fechada' ? 'já fechou · ' : (m.situacao === 'aberta' ? 'fatura aberta agora · ' : '')}vence ${dataCurta(m.data_vencimento)}</small></label>
          <input type="text" inputmode="decimal" placeholder="0,00" id="mbfIni${m.referencia}"
            value="${m.valor_inicial ? Number(m.valor_inicial).toFixed(2).replace('.', ',') : ''}">
        </div>`).join('')}
      <button class="mbf-botao" id="mbfSalvar" onclick="MB._salvarIniciais()">Salvar valores</button>
      <button class="mbf-botao secundario" onclick="${ehCadastro ? 'MB.fecharCamada()' : "MB._modoFaturas('ver')"}">${ehCadastro ? 'Não tenho parcelas antigas' : 'Cancelar'}</button>
    `;
  }

  // Soma o mesmo valor nos proximos N meses (a partir da fatura aberta).
  MB._repetirValor = function () {
    const valor = numero(document.getElementById('mbfRepValor').value);
    const meses = parseInt(document.getElementById('mbfRepMeses').value, 10);
    if (!valor || valor <= 0) { erro('Digite o valor da parcela.'); return; }
    const editaveis = estado.dados.meses.filter(m => !m.inicial_paga && m.situacao !== 'fechada').slice(0, meses);
    editaveis.forEach(m => {
      const input = document.getElementById('mbfIni' + m.referencia);
      if (!input) return;
      const atual = numero(input.value) || 0;
      input.value = (Math.round((atual + valor) * 100) / 100).toFixed(2).replace('.', ',');
    });
    document.getElementById('mbfRepValor').value = '';
  };

  MB._salvarIniciais = async function () {
    const valores = {};
    for (const m of estado.dados.meses) {
      if (m.inicial_paga) continue;
      const input = document.getElementById('mbfIni' + m.referencia);
      if (!input) continue;
      const v = numero(input.value);
      if (isNaN(v) || v < 0) { erro(`Valor inválido em ${mesCurto(m.referencia)}.`); return; }
      valores[m.referencia] = v;
    }
    const btn = document.getElementById('mbfSalvar');
    btn.disabled = true;
    try {
      await api(`/cartoes/${estado.cartaoId}/faturas-iniciais`, { method: 'PUT', body: JSON.stringify({ valores }) });
      estado.mudou = true;
      if (estado.modo === 'cadastro') {
        estado.modo = 'ver';
      } else {
        estado.modo = 'ver';
      }
      estado.dados = await api(`/cartoes/${estado.cartaoId}/faturas`);
      desenhar();
    } catch (e) {
      erro(e.message);
    } finally {
      if (document.getElementById('mbfSalvar')) document.getElementById('mbfSalvar').disabled = false;
    }
  };
})();
