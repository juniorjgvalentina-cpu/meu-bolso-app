// Calcula em qual fatura (mes/ano de vencimento) uma compra no credito cai,
// a partir do dia de fechamento do cartao. Compra feita DEPOIS do
// fechamento sempre vai pra fatura seguinte, mesmo que o vencimento dela
// esteja proximo.
function computarCicloFatura(dataCompra, diaFechamento, diaVencimento) {
  const diaCompra = dataCompra.getDate();
  let mesFechamento = dataCompra.getMonth();
  let anoFechamento = dataCompra.getFullYear();

  if (diaCompra > diaFechamento) {
    mesFechamento += 1;
    if (mesFechamento > 11) { mesFechamento = 0; anoFechamento += 1; }
  }

  let mesVencimento = mesFechamento;
  let anoVencimento = anoFechamento;
  if (diaVencimento < diaFechamento) {
    mesVencimento += 1;
    if (mesVencimento > 11) { mesVencimento = 0; anoVencimento += 1; }
  }

  const ultimoDiaDoMes = new Date(anoVencimento, mesVencimento + 1, 0).getDate();
  const diaVencimentoFinal = Math.min(diaVencimento, ultimoDiaDoMes);
  const dataVencimento = `${anoVencimento}-${String(mesVencimento + 1).padStart(2, '0')}-${String(diaVencimentoFinal).padStart(2, '0')}`;
  const referencia = `${anoVencimento}-${String(mesVencimento + 1).padStart(2, '0')}`;

  return { referencia, dataVencimento };
}

function proximoCicloFatura(referenciaAtual, diaVencimento) {
  const ano = parseInt(referenciaAtual.slice(0, 4), 10);
  const mes = parseInt(referenciaAtual.slice(5, 7), 10) - 1;
  let novoAno = ano;
  let novoMes = mes + 1;
  if (novoMes > 11) { novoMes = 0; novoAno += 1; }
  const ultimoDia = new Date(novoAno, novoMes + 1, 0).getDate();
  const diaFinal = Math.min(diaVencimento, ultimoDia);
  const dataVencimento = `${novoAno}-${String(novoMes + 1).padStart(2, '0')}-${String(diaFinal).padStart(2, '0')}`;
  const referencia = `${novoAno}-${String(novoMes + 1).padStart(2, '0')}`;
  return { referencia, dataVencimento };
}

module.exports = { computarCicloFatura, proximoCicloFatura };
