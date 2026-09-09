const express = require('express');
const router = express.Router();
const pool = require('../db');
const autenticar = require('../middleware/autenticar');

const CATEGORIAS_VALIDAS = ['entrada', 'fixo', 'superfluo', 'diaadia', 'imprevisto'];
const NOMES_CATEGORIAS = {
  entrada: 'Entrada', fixo: 'Fixo', superfluo: 'Supérfluo', diaadia: 'Dia a dia', imprevisto: 'Imprevisto'
};
const NOMES_MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

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

// Endpoint de dados em JSON (o PDF e montado no proprio iPhone via jsPDF,
// pra funcionar como download de verdade dentro do app instalado).
router.get('/relatorio/dados', autenticar, async (req, res) => {
  let { inicio, fim, categorias } = req.query;

  if (!inicio || !/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    return res.status(400).json({ erro: 'Data de inicio invalida.' });
  }
  if (!fim || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
    fim = inicio;
  }

  const dataInicio = new Date(`${inicio}T00:00:00`);
  const dataFimExclusive = new Date(`${fim}T00:00:00`);
  dataFimExclusive.setDate(dataFimExclusive.getDate() + 1);

  const totalDias = Math.round((dataFimExclusive - dataInicio) / 86400000);
  if (totalDias < 1) {
    return res.status(400).json({ erro: 'A data final precisa ser igual ou depois da inicial.' });
  }
  if (totalDias > 366) {
    return res.status(400).json({ erro: 'O periodo maximo e de 366 dias.' });
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
      SELECT descricao, data_lancamento, valor, tipo_movimento, categoria, total_parcelas, parcela_atual
      FROM lancamentos
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

    const totaisGerais = { entrada: 0, fixo: 0, superfluo: 0, diaadia: 0, imprevisto: 0 };
    const mesesResposta = meses.map(mesChave => {
      const [ano, mes] = mesChave.split('-').map(Number);
      const totaisMes = { entrada: 0, fixo: 0, superfluo: 0, diaadia: 0, imprevisto: 0 };
      const itens = porMes[mesChave].map(l => {
        const valor = Number(l.valor);
        if (l.tipo_movimento === 'entrada') totaisMes.entrada += valor;
        else if (totaisMes[l.categoria] !== undefined) totaisMes[l.categoria] += valor;
        return {
          descricao: l.descricao,
          data: l.data_lancamento,
          valor,
          tipo_movimento: l.tipo_movimento,
          categoria: l.categoria,
          total_parcelas: l.total_parcelas,
          parcela_atual: l.parcela_atual
        };
      });
      Object.keys(totaisGerais).forEach(k => { totaisGerais[k] += totaisMes[k]; });
      const saldo = totaisMes.entrada - (totaisMes.fixo + totaisMes.superfluo + totaisMes.diaadia + totaisMes.imprevisto);
      return { mesChave, ano, mes, nomeMes: NOMES_MESES[mes - 1], itens, totais: totaisMes, saldo };
    });

    const nomeArquivo = inicio === fim ? `meu-bolso-${inicio}.pdf` : `meu-bolso-${inicio}-a-${fim}.pdf`;
    const gastoTotal = totaisGerais.fixo + totaisGerais.superfluo + totaisGerais.diaadia + totaisGerais.imprevisto;

    res.json({
      meses: mesesResposta,
      subtituloPeriodo: `Período: ${formatarDataLonga(inicio)} a ${formatarDataLonga(fim)}`,
      subtituloCategorias: filtroEhTodas ? null : `Categorias: ${categoriasFiltro.map(c => NOMES_CATEGORIAS[c]).join(', ')}`,
      categoriasFiltro,
      totaisGerais,
      saldoTotal: totaisGerais.entrada - gastoTotal,
      nomeArquivo
    });
  } catch (err) {
    console.error('Erro ao buscar dados do relatorio:', err);
    res.status(500).json({ erro: 'Erro ao buscar dados do relatório. Tente novamente.' });
  }
});

module.exports = router;
