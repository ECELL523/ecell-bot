require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── Credenciais ──────────────────────────────────────────────
const INSTANCE_ID    = process.env.ZAPI_INSTANCE_ID;
const INSTANCE_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_BASE      = 'https://api.z-api.io/instances/' + INSTANCE_ID + '/token/' + INSTANCE_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const NOME_GRUPO     = 'Compras de pecas p/ ecell';
const SEU_NUMERO     = '5565992004200';

// ─── Controle de saudações do dia ────────────────────────────
// Guarda quais fornecedores já receberam saudação hoje
var saudacoesHoje = {}; // telefone → true
var ultimoDiaSaudacao = new Date().toDateString();

function resetarSaudacoesSeNovoDia() {
  var hoje = new Date().toDateString();
  if (hoje !== ultimoDiaSaudacao) {
    saudacoesHoje = {};
    ultimoDiaSaudacao = hoje;
    console.log('🌅 Novo dia — saudações resetadas');
  }
}

// ─── Banco em memória ─────────────────────────────────────────
const processados     = new Set();
const pedidosAtivos   = {};
const historicoPedidos = [];
const MAX_HISTORICO   = 100;

function salvarDados() {
  try {
    fs.writeFileSync(path.join(__dirname, 'dados.json'),
      JSON.stringify({ historico: historicoPedidos }, null, 2));
  } catch(e) {}
}

function carregarDados() {
  try {
    if (fs.existsSync(path.join(__dirname, 'dados.json'))) {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'dados.json'), 'utf-8'));
    }
  } catch(e) {}
  return { historico: [] };
}

function logPedido(dados) {
  try {
    fs.appendFileSync(path.join(__dirname, 'pedidos.log'),
      '[' + new Date().toISOString() + '] ' + JSON.stringify(dados) + '\n');
  } catch(e) {}
}

function horaAtual() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function saudacaoAtual() {
  var hora = new Date().getHours();
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

var dadosSalvos = carregarDados();
historicoPedidos.push(...(dadosSalvos.historico || []));

// ─── Webhook principal ────────────────────────────────────────
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body      = req.body;
    const isGroup   = body.isGroup || false;
    const chatName  = body.chatName || '';
    const messageId = body.messageId || body.id || '';
    const autor     = body.senderName || body.phone || '';
    const tipo      = body.type || '';
    const chatId    = body.chatId || body.phone || '';
    const phone     = body.phone || '';

    resetarSaudacoesSeNovoDia();

    // ── REAÇÃO DO FORNECEDOR (chat privado) ───────────────────
    if (!isGroup && tipo === 'ReactionCallback') {
      const emoji      = body.reactionValue || '';
      const idMensagem = body.reactionMessageId || '';

      if (pedidosAtivos[idMensagem]) {
        var pedido = pedidosAtivos[idMensagem];

        if (emoji === '👍') {
          console.log('✅ Fornecedor TEM: ' + pedido.peca + ' ' + pedido.modelo);
          var msgGrupo = '✅ *' + pedido.fornecedor + ' TEM disponível!*\n\n';
          msgGrupo += '📦 Peça: *' + pedido.peca + ' ' + pedido.modelo + '*\n';
          msgGrupo += '🔢 Quantidade: ' + pedido.quantidade + ' unidade(s)\n';
          msgGrupo += '👤 Pedido de: ' + pedido.autor;
          await enviarMensagem(pedido.chatId, msgGrupo);
          pedidosAtivos[idMensagem].resolvido = true;

        } else if (emoji === '❌') {
          console.log('❌ Fornecedor NÃO tem: ' + pedido.peca + ' ' + pedido.modelo);
          var msgNeg = '❌ *' + pedido.fornecedor + ' NÃO tem disponível*\n';
          msgNeg += '📦 ' + pedido.peca + ' ' + pedido.modelo + '\n🔍 Buscando outro fornecedor...';
          await enviarMensagem(pedido.chatId, msgNeg);
          await buscarProximoFornecedor(pedido, idMensagem);
        }
      }
      return;
    }

    // ── RESPOSTA DE TEXTO DO FORNECEDOR ───────────────────────
    if (!isGroup && tipo === 'ReceivedCallback') {
      var textoResp = '';
      if (body.text && body.text.message) textoResp = body.text.message;
      else if (typeof body.text === 'string') textoResp = body.text;
      if (textoResp) await processarRespostaTextoFornecedor(phone, textoResp, autor);
      return;
    }

    // ── MENSAGENS DO GRUPO ────────────────────────────────────
    if (!isGroup || !chatName.includes('Compras de pecas')) return;
    if (processados.has(messageId)) return;
    processados.add(messageId);
    if (processados.size > 500) processados.delete(processados.values().next().value);

    var texto = '';
    if (body.text && body.text.message) texto = body.text.message;
    else if (typeof body.text === 'string') texto = body.text;

    var imageUrl = null;
    if (body.image && body.image.imageUrl) imageUrl = body.image.imageUrl;
    else if (body.image && body.image.url) imageUrl = body.image.url;

    if (!texto && !imageUrl) return;
    if (texto && texto.length < 3 && !imageUrl) return;

    console.log('\n📩 [' + horaAtual() + '] ' + autor + ': ' + (texto || '[imagem]'));

    await processarMensagem(texto, imageUrl, autor, messageId, chatId);

  } catch (err) {
    console.error('Erro webhook: ' + err.message);
  }
});

// ─── Processa mensagem do grupo ───────────────────────────────
async function processarMensagem(texto, imageUrl, autor, msgId, chatId) {
  var dados        = JSON.parse(fs.readFileSync(path.join(__dirname, 'fornecedores.json'), 'utf-8'));
  var fornecedores = dados.fornecedores;
  var quantidades  = dados.quantidades_fixas;

  var listaF = fornecedores.map(function(f) {
    return 'ID: ' + f.id + ' | Nome: ' + f.nome + ' | Telefone: ' + f.telefone + ' | Tipos: ' + f.tipo_peca.join(', ');
  }).join('\n');

  var listaQ = Object.entries(quantidades).map(function(e) {
    return e[0] + ': ' + e[1] + ' unidades (padrão se não informado)';
  }).join('\n');

  var conteudo = [];

  if (imageUrl) {
    try {
      var imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      var base64  = Buffer.from(imgResp.data).toString('base64');
      var mime    = imgResp.headers['content-type'] || 'image/jpeg';
      conteudo.push({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } });
      console.log('📸 Imagem carregada');
    } catch(e) {
      console.error('Erro imagem: ' + e.message);
    }
  }

  var prompt = 'Voce e assistente de compras da loja Ecell de pecas de celular.\n\n';
  prompt += 'FORNECEDORES:\n' + listaF + '\n\n';
  prompt += 'QUANTIDADES PADRAO:\n' + listaQ + '\n\n';
  prompt += 'MENSAGEM de ' + autor + ': "' + (texto || '[veja imagem]') + '"\n\n';
  prompt += 'Hora atual: ' + horaAtual() + '\n\n';
  prompt += 'Classifique e responda em JSON:\n\n';
  prompt += '1. Se for SAUDACAO (bom dia, boa tarde, boa noite, oi, ola, bom dia a todos, etc):\n';
  prompt += '{"tipo":"saudacao","saudacao":"Bom dia","fornecedores_todos":true}\n\n';
  prompt += '2. Se for PEDIDO DE PECA (ex: "tela s22 | Qnt 3" ou "display redmi 15" ou foto de peca):\n';
  prompt += '{"tipo":"pedido","tipo_peca":"...","modelo_celular":"...","fornecedor_id":"...","fornecedor_nome":"...","fornecedor_telefone":"...","quantidade":N,"mensagem_fornecedor":"mensagem profissional","urgente":false,"peca_rara":false}\n';
  prompt += 'IMPORTANTE: Se a mensagem tiver "| Qnt X" ou "quantidade X" ou "X unidades", use ESSE numero como quantidade!\n\n';
  prompt += '3. Se nao for nenhum dos dois:\n';
  prompt += '{"tipo":"ignorar"}\n\n';
  prompt += 'SOMENTE JSON valido.';

  conteudo.push({ type: 'text', text: prompt });

  var resultado;
  try {
    var resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: conteudo }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    var txt = resp.data.content[0].text.trim().replace(/```json/g,'').replace(/```/g,'').trim();
    resultado = JSON.parse(txt);

  } catch (err) {
    console.error('Erro Claude: ' + err.message);
    return;
  }

  // ── SAUDAÇÃO ──────────────────────────────────────────────
  if (resultado.tipo === 'saudacao') {
    console.log('👋 Saudação detectada — enviando para fornecedores não cumprimentados hoje');

    var saudacaoEnviada = false;
    for (var f of fornecedores) {
      if (!saudacoesHoje[f.telefone]) {
        var msgSaudacao = saudacaoAtual() + '! 😊 Tudo bem?\nAqui é a Leticia, vou começar a encaminhar nossos pedidos do dia. Se tiver reage com 👍 se não tiver ❌';
        try {
          await enviarMensagem(f.telefone, msgSaudacao);
          saudacoesHoje[f.telefone] = true;
          saudacaoEnviada = true;
          console.log('👋 Saudação enviada para: ' + f.nome);
        } catch(e) {
          console.error('Erro saudação ' + f.nome + ': ' + e.message);
        }
      } else {
        console.log('ℹ️  ' + f.nome + ' já recebeu saudação hoje');
      }
    }

    if (saudacaoEnviada) {
      try {
        await axios.post(ZAPI_BASE + '/send-reaction', { phone: chatId, messageId: msgId, reaction: '✅' });
      } catch(e) {}
    }
    return;
  }

  // ── IGNORAR ───────────────────────────────────────────────
  if (resultado.tipo === 'ignorar') {
    console.log('ℹ️  Ignorado pela IA');
    return;
  }

  // ── PEDIDO ────────────────────────────────────────────────
  if (resultado.tipo === 'pedido') {
    console.log('📦 ' + resultado.tipo_peca + ' - ' + resultado.modelo_celular + ' | Qtd: ' + resultado.quantidade + (resultado.urgente ? ' ⚡ URGENTE' : ''));

    var msgFornecedor = resultado.mensagem_fornecedor + '\n\nResponda 👍 se TEM ou ❌ se NÃO TEM';

    // Urgente ou raro → envia para todos
    if (resultado.urgente || resultado.peca_rara) {
      var prefixo = resultado.urgente ? '⚡ URGENTE - ' : '🔍 ';
      for (var f2 of fornecedores) {
        try {
          var msgId2 = await enviarMensagemRetornaId(f2.telefone, prefixo + msgFornecedor);
          if (msgId2) {
            pedidosAtivos[msgId2] = {
              chatId, autor,
              peca: resultado.tipo_peca,
              modelo: resultado.modelo_celular,
              quantidade: resultado.quantidade,
              fornecedor: f2.nome,
              fornecedorTelefone: f2.telefone,
              todosFornecedores: fornecedores,
              fornecedorIndex: fornecedores.indexOf(f2),
              resolvido: false
            };
          }
        } catch(e) {}
      }
      await enviarMensagem(chatId,
        (resultado.urgente ? '⚡ *Pedido URGENTE!*' : '🔍 *Peça rara!*') +
        '\nConsultando todos os fornecedores sobre *' + resultado.tipo_peca + ' ' + resultado.modelo_celular + '*...'
      );

    } else {
      // Normal → fornecedor principal
      var novoMsgId = await enviarMensagemRetornaId(resultado.fornecedor_telefone, msgFornecedor);
      if (novoMsgId) {
        pedidosAtivos[novoMsgId] = {
          chatId, autor,
          peca: resultado.tipo_peca,
          modelo: resultado.modelo_celular,
          quantidade: resultado.quantidade,
          fornecedor: resultado.fornecedor_nome,
          fornecedorTelefone: resultado.fornecedor_telefone,
          todosFornecedores: fornecedores,
          fornecedorIndex: 0,
          resolvido: false
        };

        // Follow-up 30min
        setTimeout(async function() {
          if (pedidosAtivos[novoMsgId] && !pedidosAtivos[novoMsgId].resolvido) {
            try {
              await enviarMensagem(resultado.fornecedor_telefone,
                '⏰ Oi! Ainda aguardamos sobre *' + resultado.tipo_peca + ' ' + resultado.modelo_celular + '*. Tem disponível? Responda 👍 ou ❌');
              await enviarMensagem(SEU_NUMERO,
                '⚠️ *' + resultado.fornecedor_nome + '* não respondeu em 30min sobre *' + resultado.tipo_peca + ' ' + resultado.modelo_celular + '*');
            } catch(e) {}
          }
        }, 30 * 60 * 1000);
      }
      console.log('📤 Enviado para: ' + resultado.fornecedor_nome);
    }

    // Reage com ✅ no grupo
    try {
      await axios.post(ZAPI_BASE + '/send-reaction', { phone: chatId, messageId: msgId, reaction: '✅' });
    } catch(e) {}

    // Salva histórico
    var reg = {
      data: new Date().toISOString(), autor,
      pedido: texto, imagem: !!imageUrl,
      peca: resultado.tipo_peca, modelo: resultado.modelo_celular,
      quantidade: resultado.quantidade,
      fornecedor: resultado.fornecedor_nome || 'Múltiplos',
      urgente: resultado.urgente || false
    };
    historicoPedidos.push(reg);
    if (historicoPedidos.length > MAX_HISTORICO) historicoPedidos.shift();
    salvarDados();
    logPedido(reg);
  }
}

// ─── Busca próximo fornecedor ─────────────────────────────────
async function buscarProximoFornecedor(pedido, msgIdAnterior) {
  if (!pedido.todosFornecedores) return;
  var idx = (pedido.fornecedorIndex || 0) + 1;
  var proximo = pedido.todosFornecedores[idx];

  if (!proximo) {
    await enviarMensagem(pedido.chatId,
      '⚠️ *Nenhum fornecedor tem disponível!*\n📦 ' + pedido.peca + ' ' + pedido.modelo);
    await enviarMensagem(SEU_NUMERO,
      '🚨 Nenhum fornecedor tem *' + pedido.peca + ' ' + pedido.modelo + '*! Pedido de ' + pedido.autor);
    return;
  }

  var msg = '🔍 Preciso de: *' + pedido.peca + ' ' + pedido.modelo + '*\nQtd: ' + pedido.quantidade + '\nResponda 👍 se TEM ou ❌ se NÃO TEM';
  var novoId = await enviarMensagemRetornaId(proximo.telefone, msg);
  if (novoId) {
    pedidosAtivos[novoId] = { ...pedido, fornecedor: proximo.nome, fornecedorTelefone: proximo.telefone, fornecedorIndex: idx, resolvido: false };
    console.log('🔄 Tentando: ' + proximo.nome);
  }
}

// ─── Processa resposta texto do fornecedor ────────────────────
async function processarRespostaTextoFornecedor(phone, mensagem, nome) {
  var pedidoRelacionado = null;
  var chaveEncontrada   = null;
  for (var chave in pedidosAtivos) {
    if (pedidosAtivos[chave].fornecedorTelefone === phone && !pedidosAtivos[chave].resolvido) {
      pedidoRelacionado = pedidosAtivos[chave];
      chaveEncontrada   = chave;
      break;
    }
  }
  if (!pedidoRelacionado) return;

  try {
    var resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: 'Fornecedor respondeu: "' + mensagem + '"\nSobre: ' + pedidoRelacionado.peca + ' ' + pedidoRelacionado.modelo + '\nTem disponivel? JSON: {"tem":true/false,"preco":"valor ou null","prazo":"prazo ou null"}'
      }]
    }, {
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    });

    var analise = JSON.parse(resp.data.content[0].text.trim().replace(/```json/g,'').replace(/```/g,'').trim());
    pedidosAtivos[chaveEncontrada].resolvido = true;

    var msgG = analise.tem
      ? '✅ *' + (nome||'Fornecedor') + ' TEM!*\n📦 ' + pedidoRelacionado.peca + ' ' + pedidoRelacionado.modelo +
        (analise.preco ? '\n💰 ' + analise.preco : '') + (analise.prazo ? '\n🚚 ' + analise.prazo : '') + '\n💬 "' + mensagem + '"'
      : '❌ *' + (nome||'Fornecedor') + ' NÃO tem*\n📦 ' + pedidoRelacionado.peca + ' ' + pedidoRelacionado.modelo;

    await enviarMensagem(pedidoRelacionado.chatId, msgG);
    if (!analise.tem) await buscarProximoFornecedor(pedidoRelacionado, chaveEncontrada);
  } catch(e) {}
}

// ─── Helpers ──────────────────────────────────────────────────
async function enviarMensagem(para, texto) {
  await axios.post(ZAPI_BASE + '/send-text', { phone: para, message: texto });
}

async function enviarMensagemRetornaId(para, texto) {
  try {
    var r = await axios.post(ZAPI_BASE + '/send-text', { phone: para, message: texto });
    return r.data?.zaapId || r.data?.messageId || r.data?.id || null;
  } catch(e) { return null; }
}

// ─── Relatório diário ─────────────────────────────────────────
function agendarRelatorio() {
  var agora = new Date(), proximo = new Date();
  proximo.setHours(18, 0, 0, 0);
  if (proximo <= agora) proximo.setDate(proximo.getDate() + 1);
  setTimeout(async function() { await enviarRelatorio(); agendarRelatorio(); }, proximo - agora);
}

async function enviarRelatorio() {
  var hoje = new Date().toDateString();
  var pedidosHoje = historicoPedidos.filter(p => new Date(p.data).toDateString() === hoje);
  if (!pedidosHoje.length) return;

  var fornCount = {}, pecaCount = {};
  pedidosHoje.forEach(p => {
    fornCount[p.fornecedor] = (fornCount[p.fornecedor]||0)+1;
    pecaCount[p.peca] = (pecaCount[p.peca]||0)+1;
  });

  var rel = '📊 *Relatório ' + new Date().toLocaleDateString('pt-BR') + '*\n\n';
  rel += '📦 Total: ' + pedidosHoje.length + ' pedidos\n\n🏪 *Fornecedores:*\n';
  for (var f in fornCount) rel += '  • ' + f + ': ' + fornCount[f] + 'x\n';
  rel += '\n🔧 *Mais pedidas:*\n';
  Object.entries(pecaCount).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(p => { rel += '  • ' + p[0] + ': ' + p[1] + 'x\n'; });
  try { await enviarMensagem(SEU_NUMERO, rel); } catch(e) {}
}

// ─── Painel web ───────────────────────────────────────────────
app.get('/', function(req, res) {
  var hoje = new Date().toDateString();
  var pedidosHoje = historicoPedidos.filter(p => new Date(p.data).toDateString() === hoje);
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ecell Bot</title>';
  html += '<style>body{font-family:sans-serif;padding:20px;background:#f0f2f5}h1{color:#25D366}';
  html += 'table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px}';
  html += 'th{background:#25D366;color:#fff;padding:12px}td{padding:10px;border-bottom:1px solid #eee}';
  html += '.stats{display:flex;gap:15px;margin-bottom:20px}.stat{background:#fff;padding:15px;border-radius:8px;flex:1;text-align:center}';
  html += '.stat h2{margin:0;color:#25D366}.ok{color:green}.urgente{color:red}</style></head><body>';
  html += '<h1>🤖 Ecell Bot</h1><div class="stats">';
  html += '<div class="stat"><h2>' + pedidosHoje.length + '</h2><p>Pedidos hoje</p></div>';
  html += '<div class="stat"><h2>' + historicoPedidos.length + '</h2><p>Total</p></div>';
  html += '<div class="stat"><h2>' + Object.keys(saudacoesHoje).length + '</h2><p>Saudações hoje</p></div>';
  html += '<div class="stat"><h2>' + Object.keys(pedidosAtivos).filter(k=>!pedidosAtivos[k].resolvido).length + '</h2><p>Aguardando</p></div>';
  html += '</div><table><tr><th>Hora</th><th>Solicitante</th><th>Peça</th><th>Modelo</th><th>Qtd</th><th>Fornecedor</th><th>Status</th></tr>';
  historicoPedidos.slice(-50).reverse().forEach(p => {
    var hora = new Date(p.data).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    html += '<tr><td>' + hora + '</td><td>' + p.autor + '</td><td>' + p.peca + '</td>';
    html += '<td>' + p.modelo + '</td><td>' + (p.quantidade||1) + '</td><td>' + (p.fornecedor||'-') + '</td>';
    html += '<td class="' + (p.urgente?'urgente':'ok') + '">' + (p.urgente?'⚡ Urgente':'✅ OK') + '</td></tr>';
  });
  html += '</table></body></html>';
  res.send(html);
});

// ─── Inicia ───────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('\n🚀 Ecell Bot na porta ' + PORT);
  console.log('🎯 Grupo: ' + NOME_GRUPO);
  console.log('👋 Saudação automática: SIM (1x por dia por fornecedor)');
  console.log('📦 Formato pedido: "tela s22 | Qnt 3"');
  console.log('📸 Imagens: SIM');
  console.log('👍❌ Reação fornecedor: SIM');
  console.log('🔄 Próximo fornecedor automático: SIM');
  console.log('⚡ Urgência: SIM');
  console.log('📊 Relatório: 18h');
  console.log('🌐 Painel: http://localhost:' + PORT);
  console.log('\nAguardando mensagens...\n');
  agendarRelatorio();
});
