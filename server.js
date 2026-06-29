require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

const INSTANCE_ID    = process.env.ZAPI_INSTANCE_ID;
const INSTANCE_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_BASE      = 'https://api.z-api.io/instances/' + INSTANCE_ID + '/token/' + INSTANCE_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;

const cacheMensagens = {};

function salvarNoCache(id, texto, autor) {
  const ids = Object.keys(cacheMensagens);
  if (ids.length >= 300) delete cacheMensagens[ids[0]];
  cacheMensagens[id] = { texto: texto, autor: autor };
  console.log('Cache salvo: [' + autor + '] ' + texto);
}

function logPedido(dados) {
  try {
    fs.appendFileSync(path.join(__dirname, 'pedidos.log'), JSON.stringify(dados) + '\n');
  } catch(e) {}
}

app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('Evento recebido tipo: ' + (body.type || 'desconhecido') + ' | isGroup: ' + body.isGroup);

    const isGroup   = body.isGroup || false;
    const chatId    = body.chatId || body.phone || '';
    const messageId = body.messageId || body.id || '';
    const autor     = body.senderName || body.phone || '';
    const tipo      = body.type || '';

    var texto = '';
    if (body.text && body.text.message) texto = body.text.message;
    else if (typeof body.text === 'string') texto = body.text;

    if (!isGroup) {
      console.log('Mensagem ignorada: nao e grupo');
      return;
    }

    if (tipo === 'ReceivedCallback' && texto) {
      salvarNoCache(messageId, texto, autor);
      return;
    }

    if (tipo === 'ReactionCallback') {
      const emoji      = body.reactionValue || '';
      const idOriginal = body.reactionMessageId || '';
      console.log('Reacao recebida: ' + emoji + ' na mensagem ' + idOriginal);

      if (emoji !== '\uD83D\uDC4D') {
        console.log('Emoji ignorado: ' + emoji);
        return;
      }

      const cached = cacheMensagens[idOriginal];
      if (!cached) {
        console.log('Mensagem nao encontrada no cache para id: ' + idOriginal);
        console.log('Cache atual: ' + JSON.stringify(Object.keys(cacheMensagens)));
        return;
      }

      console.log('Processando pedido: ' + cached.texto);
      await processarPedido(cached.texto, cached.autor, idOriginal, chatId);
      delete cacheMensagens[idOriginal];
    }
  } catch (err) {
    console.error('Erro webhook: ' + err.message);
  }
});

async function processarPedido(textoPedido, autor, msgId, groupId) {
  var dados = JSON.parse(fs.readFileSync(path.join(__dirname, 'fornecedores.json'), 'utf-8'));
  var fornecedores = dados.fornecedores;
  var quantidades  = dados.quantidades_fixas;

  var listaF = fornecedores.map(function(f) {
    return 'ID: ' + f.id + ' | Nome: ' + f.nome + ' | Telefone: ' + f.telefone + ' | Tipos: ' + f.tipo_peca.join(', ');
  }).join('\n');

  var listaQ = Object.entries(quantidades).map(function(e) {
    return e[0] + ': ' + e[1] + ' unidades';
  }).join('\n');

  var resultado;
  try {
    var response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: 'Voce e assistente de compras da loja Ecell de pecas de celular.\n\nFORNECEDORES:\n' + listaF + '\n\nQUANTIDADES FIXAS:\n' + listaQ + '\n\nPEDIDO: "' + textoPedido + '"\nSolicitante: ' + autor + '\n\nResponda SOMENTE em JSON valido sem texto extra:\n{"tipo_peca":"tipo","modelo_celular":"modelo","fornecedor_id":"id","fornecedor_nome":"nome","fornecedor_telefone":"telefone","quantidade":1,"mensagem_fornecedor":"mensagem profissional"}'
      }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    var txt = response.data.content[0].text.trim();
    txt = txt.replace(/```json/g,'').replace(/```/g,'').trim();
    resultado = JSON.parse(txt);
    console.log('Pedido identificado: ' + resultado.tipo_peca + ' - ' + resultado.modelo_celular);
    console.log('Enviando para: ' + resultado.fornecedor_nome + ' (' + resultado.fornecedor_telefone + ')');
  } catch (err) {
    console.error('Erro Claude: ' + err.message);
    return;
  }

  try {
    await axios.post(ZAPI_BASE + '/send-text', {
      phone: resultado.fornecedor_telefone,
      message: resultado.mensagem_fornecedor
    });
    console.log('Mensagem enviada ao fornecedor!');
  } catch (err) {
    console.error('Erro ao enviar ao fornecedor: ' + err.message);
    return;
  }

  try {
    await axios.post(ZAPI_BASE + '/send-reaction', {
      phone: groupId,
      messageId: msgId,
      reaction: '\u2705'
    });
    console.log('Reagiu com OK no grupo!');
  } catch (err) {
    console.error('Erro ao reagir: ' + err.message);
  }

  logPedido({ autor: autor, pedido: textoPedido, fornecedor: resultado.fornecedor_nome, peca: resultado.tipo_peca });
}

app.listen(3000, function() {
  console.log('');
  console.log('Ecell Bot rodando na porta 3000');
  console.log('Webhook: http://localhost:3000/webhook');
  console.log('Claude: OK');
  console.log('');
  console.log('Aguardando mensagens do grupo...');
  console.log('');
});