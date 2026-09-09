const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const pool = require('../db');

const CORES = {
  fixo: '#2F6FED',
  superfluo: '#E8922C',
  diaadia: '#D9B62C',
  imprevisto: '#D64545',
  entrada: '#2F9E68'
};
const INK = '#16261F';
const INK_SOFT = '#3C4B43';
const LINE = '#E4DFD1';

const NOMES_MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const CATEGORIAS_VALIDAS = ['entrada', 'fixo', 'superfluo', 'diaadia', 'imprevisto'];
const NOMES_CATEGORIAS = {
  entrada: 'Entrada', fixo: 'Fixo', superfluo: 'Supérfluo', diaadia: 'Dia a dia', imprevisto: 'Imprevisto'
};

function formatarMoeda(valor) {
  const n = Number(valor || 0);
  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const intFormatado = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${intFormatado},${decPart}`;
}

function formatarDataCurta(data) {
  const d = new Date(data);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function formatarDataLonga(dataISO) {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

// Lista os meses (formato YYYY-MM) que o intervalo de dias toca, inclusive.
function listarMesesDoIntervalo(dataInicioISO, dataFimISO) {
  const meses = [];
  let [ano, mes] = dataInicioISO.split('-').map(Number);
  const [anoFim, mesFim] = dataFimISO.split('-').map(Number);
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  return meses;
}

// Autenticacao via query string, ja que esse endpoint e acessado por link
// direto (download de arquivo), onde nao da pra mandar cabecalho customizado.
async function autenticarPorQuery(req, res, next) {
  const token = req.query.token;
  if (!token) {
    return res.status(401).send('Token nao fornecido.');
  }
  try {
    const result = await pool.query(
      `SELECT m.id AS membro_id, m.nome, m.papel, m.visao_completa, m.conta_id
       FROM membros m WHERE m.token_acesso = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(401).send('Token invalido.');
    }
    const row = result.rows[0];
    req.membro = { id: row.membro_id, nome: row.nome, papel: row.papel, visao_completa: row.visao_completa };
    req.conta = { id: row.conta_id };
    next();
  } catch (err) {
    console.error('Erro ao autenticar relatorio:', err);
    res.status(500).send('Erro de autenticacao.');
  }
}

router.get('/relatorio/pdf', autenticarPorQuery, async (req, res) => {
  let { inicio, fim, categorias } = req.query;

  if (!inicio || !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    return res.status(400).send('Data de inicio invalida.');
  }
  if (!fim || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    fim = inicio;
  }

  const dataInicio = new Date(`${inicio}T00:00:00`);
  const dataFimExclusive = new Date(`${fim}T00:00:00`);
  dataFimExclusive.setDate(dataFimExclusive.getDate() + 1);

  const totalDias = Math.round((dataFimExclusive - dataInicio) / 86400000);
  if (totalDias < 1) {
    return res.status(400).send('A data final precisa ser igual ou depois da inicial.');
  }
  if (totalDias > 366) {
    return res.status(400).send('O periodo maximo e de 366 dias.');
  }

  let categoriasFiltro = CATEGORIAS_VALIDAS;
  if (categorias) {
    categoriasFiltro = categorias.split(',').map(c => c.trim()).filter(c => CATEGORIAS_VALIDAS.includes(c));
    if (categoriasFiltro.length === 0) categoriasFiltro = CATEGORIAS_VALIDAS;
  }
  const filtroEhTodas = categoriasFiltro.length === CATEGORIAS_VALIDAS.length;

  const categoriasSaida = categoriasFiltro.filter(c => c !== 'entrada');
  const incluiEntrada = categoriasFiltro.includes('entrada');

  try {
    let query = `
      SELECT * FROM lancamentos
      WHERE conta_id = $1 AND data_lancamento >= $2 AND data_lancamento < $3
    `;
    const params = [req.conta.id, dataInicio, dataFimExclusive];

    const condicoesCategoria = [];
    if (incluiEntrada) {
      params.push('entrada');
      condicoesCategoria.push(`tipo_movimento = $${params.length}`);
    }
    if (categoriasSaida.length > 0) {
      params.push(categoriasSaida);
      condicoesCategoria.push(`(tipo_movimento = 'saida' AND categoria = ANY($${params.length}))`);
    }
    if (condicoesCategoria.length > 0) {
      query += ` AND (${condicoesCategoria.join(' OR ')})`;
    }

    if (!req.membro.visao_completa) {
      params.push(req.membro.id);
      query += ` AND membro_id = $${params.length}`;
    }
    query += ` ORDER BY data_lancamento ASC`;

    const result = await pool.query(query, params);
    const lancamentos = result.rows;

    const meses = listarMesesDoIntervalo(inicio.slice(0, 7), fim.slice(0, 7));
    const porMes = {};
    meses.forEach(m => { porMes[m] = []; });
    lancamentos.forEach(l => {
      const d = new Date(l.data_lancamento);
      const chave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (porMes[chave]) porMes[chave].push(l);
    });

    const nomeArquivo = inicio === fim
      ? `meu-bolso-${inicio}.pdf`
      : `meu-bolso-${inicio}-a-${fim}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);

    const subtituloPeriodo = `Período: ${formatarDataLonga(inicio)} a ${formatarDataLonga(fim)}`;
    const subtituloCategorias = filtroEhTodas
      ? null
      : `Categorias: ${categoriasFiltro.map(c => NOMES_CATEGORIAS[c]).join(', ')}`;

    const totaisGerais = { entrada: 0, fixo: 0, superfluo: 0, diaadia: 0, imprevisto: 0 };
    const resumoMeses = [];

    meses.forEach((mesChave, idx) => {
      if (idx > 0) doc.addPage();

      const [ano, mes] = mesChave.split('-').map(Number);
      const itens = porMes[mesChave];

      doc.fillColor(INK).fontSize(18).font('Helvetica-Bold')
        .text('Meu Bolso', 40, 40);
      doc.fillColor(INK_SOFT).fontSize(12).font('Helvetica')
        .text(`${NOMES_MESES[mes - 1]} de ${ano}`, 40, 64);
      doc.fillColor(INK_SOFT).fontSize(9.5).font('Helvetica')
        .text(subtituloCategorias ? `${subtituloPeriodo} · ${subtituloCategorias}` : subtituloPeriodo, 40, 80);
      doc.moveTo(40, 96).lineTo(555, 96).strokeColor(LINE).lineWidth(1).stroke();

      let y = 112;
      const totaisMes = { entrada: 0, fixo: 0, superfluo: 0, diaadia: 0, imprevisto: 0 };

      if (itens.length === 0) {
        doc.fillColor(INK_SOFT).fontSize(11).font('Helvetica')
          .text('Nenhum lançamento neste período.', 40, y);
        y += 24;
      } else {
        itens.forEach(l => {
          if (y > 750) {
            doc.addPage();
            y = 40;
          }
          const valor = Number(l.valor);
          const cor = l.tipo_movimento === 'entrada' ? CORES.entrada : (CORES[l.categoria] || CORES.imprevisto);

          if (l.tipo_movimento === 'entrada') totaisMes.entrada += valor;
          else if (totaisMes[l.categoria] !== undefined) totaisMes[l.categoria] += valor;

          doc.circle(46, y + 6, 4).fill(cor);

          const parcelaInfo = l.total_parcelas ? ` (${l.parcela_atual}/${l.total_parcelas})` : '';
          doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold')
            .text(`${l.descricao}${parcelaInfo}`, 58, y, { width: 320, continued: false });
          doc.fillColor(INK_SOFT).fontSize(9).font('Helvetica')
            .text(formatarDataCurta(l.data_lancamento), 58, y + 13);

          const sinal = l.tipo_movimento === 'entrada' ? '+' : '-';
          doc.fillColor(l.tipo_movimento === 'entrada' ? CORES.entrada : INK)
            .fontSize(10.5).font('Helvetica-Bold')
            .text(`${sinal}${formatarMoeda(valor)}`, 400, y, { width: 155, align: 'right' });

          y += 28;
        });
      }

      const saldoMes = totaisMes.entrada - (totaisMes.fixo + totaisMes.superfluo + totaisMes.diaadia + totaisMes.imprevisto);
      resumoMeses.push({ mesChave, ano, mes, ...totaisMes, saldo: saldoMes });

      Object.keys(totaisGerais).forEach(k => { totaisGerais[k] += totaisMes[k]; });

      y += 10;
      if (y > 700) { doc.addPage(); y = 40; }
      doc.moveTo(40, y).lineTo(555, y).strokeColor(LINE).lineWidth(1).stroke();
      y += 14;

      doc.fillColor(INK).fontSize(11).font('Helvetica-Bold').text('Resumo do mês', 40, y);
      y += 18;

      const linhasResumo = [
        ['Entradas', totaisMes.entrada, CORES.entrada, 'entrada'],
        ['Fixo', totaisMes.fixo, CORES.fixo, 'fixo'],
        ['Supérfluo', totaisMes.superfluo, CORES.superfluo, 'superfluo'],
        ['Dia a dia', totaisMes.diaadia, CORES.diaadia, 'diaadia'],
        ['Imprevisto', totaisMes.imprevisto, CORES.imprevisto, 'imprevisto']
      ].filter(([, , , chave]) => categoriasFiltro.includes(chave));
      linhasResumo.forEach(([label, valor, cor]) => {
        doc.circle(46, y + 5, 4).fill(cor);
        doc.fillColor(INK_SOFT).fontSize(10).font('Helvetica').text(label, 58, y);
        doc.fillColor(INK).fontSize(10).font('Helvetica-Bold')
          .text(formatarMoeda(valor), 400, y, { width: 155, align: 'right' });
        y += 16;
      });

      y += 4;
      doc.fillColor(INK).fontSize(11.5).font('Helvetica-Bold').text('Saldo do mês', 58, y);
      doc.fillColor(saldoMes < 0 ? CORES.imprevisto : CORES.entrada).fontSize(11.5).font('Helvetica-Bold')
        .text(formatarMoeda(saldoMes), 400, y, { width: 155, align: 'right' });
    });

    // Se o periodo cobre mais de um mes, adiciona uma pagina de resumo total.
    if (meses.length > 1) {
      doc.addPage();
      doc.fillColor(INK).fontSize(18).font('Helvetica-Bold').text('Meu Bolso', 40, 40);
      doc.fillColor(INK_SOFT).fontSize(12).font('Helvetica')
        .text('Resumo total', 40, 64);
      doc.fillColor(INK_SOFT).fontSize(9.5).font('Helvetica')
        .text(subtituloCategorias ? `${subtituloPeriodo} · ${subtituloCategorias}` : subtituloPeriodo, 40, 80);
      doc.moveTo(40, 96).lineTo(555, 96).strokeColor(LINE).lineWidth(1).stroke();

      let y = 112;
      doc.fillColor(INK).fontSize(11).font('Helvetica-Bold').text('Mês', 40, y);
      doc.text('Entradas', 180, y, { width: 90, align: 'right' });
      doc.text('Gastos', 280, y, { width: 90, align: 'right' });
      doc.text('Saldo', 460, y, { width: 95, align: 'right' });
      y += 18;
      doc.moveTo(40, y).lineTo(555, y).strokeColor(LINE).lineWidth(1).stroke();
      y += 10;

      resumoMeses.forEach(r => {
        const gastoMes = r.fixo + r.superfluo + r.diaadia + r.imprevisto;
        doc.fillColor(INK).fontSize(10).font('Helvetica')
          .text(`${NOMES_MESES[r.mes - 1]}/${r.ano}`, 40, y);
        doc.fillColor(CORES.entrada).text(formatarMoeda(r.entrada), 180, y, { width: 90, align: 'right' });
        doc.fillColor(INK).text(formatarMoeda(gastoMes), 280, y, { width: 90, align: 'right' });
        doc.fillColor(r.saldo < 0 ? CORES.imprevisto : CORES.entrada).font('Helvetica-Bold')
          .text(formatarMoeda(r.saldo), 460, y, { width: 95, align: 'right' });
        y += 20;
      });

      y += 8;
      doc.moveTo(40, y).lineTo(555, y).strokeColor(LINE).lineWidth(1).stroke();
      y += 14;

      const gastoTotal = totaisGerais.fixo + totaisGerais.superfluo + totaisGerais.diaadia + totaisGerais.imprevisto;
      const saldoTotal = totaisGerais.entrada - gastoTotal;

      doc.fillColor(INK).fontSize(12).font('Helvetica-Bold').text('Total do período', 40, y);
      y += 20;
      doc.fillColor(INK_SOFT).fontSize(10.5).font('Helvetica').text('Entradas', 58, y);
      doc.fillColor(CORES.entrada).fontSize(10.5).font('Helvetica-Bold').text(formatarMoeda(totaisGerais.entrada), 400, y, { width: 155, align: 'right' });
      y += 16;
      doc.fillColor(INK_SOFT).fontSize(10.5).font('Helvetica').text('Gastos', 58, y);
      doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold').text(formatarMoeda(gastoTotal), 400, y, { width: 155, align: 'right' });
      y += 20;
      doc.fillColor(INK).fontSize(12.5).font('Helvetica-Bold').text('Saldo do período', 58, y);
      doc.fillColor(saldoTotal < 0 ? CORES.imprevisto : CORES.entrada).fontSize(12.5).font('Helvetica-Bold')
        .text(formatarMoeda(saldoTotal), 400, y, { width: 155, align: 'right' });
    }

    doc.end();
  } catch (err) {
    console.error('Erro ao gerar relatorio PDF:', err);
    res.status(500).send('Erro ao gerar relatório. Tente novamente.');
  }
});

module.exports = router;
