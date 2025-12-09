require('dotenv').config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    jidNormalizedUser // IMPORTANTE: Função para normalizar JID/LID
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { sendButtons } = require('./buttons'); 
const pino = require('pino');
const fs = require('fs');

// ================= ESTADOS DE USUÁRIOS (EM MEMÓRIA PARA EVITAR REPETIÇÕES) =================
const estados = new Map(); // { jid: { nivel: 0, muteAte: 0 } }

function getEstado(jid) {
    return estados.get(jid) || { nivel: 0, muteAte: 0 };
}

function atualizarEstado(jid, nivel, muteAte = 0) {
    estados.set(jid, { nivel, muteAte });
}

// ================= FLAG GLOBAL PARA EVITAR SPAM DE LOGS =================
let isOnline = false;

// ================= CONFIGURAÇÕES =================
const ADMIN_JID = process.env.NUMERO_ADMIN;

// Carrega Planos
let planos = [];
try {
    planos = JSON.parse(fs.readFileSync('./planos.json', 'utf-8'));
} catch (e) {
    console.error("ERRO: Crie o arquivo planos.json na raiz!");
}

// Carrega Auto-Ajuda (novo sistema)
let autoajuda = { ajudas: [] };
try {
    autoajuda = JSON.parse(fs.readFileSync('./autoajuda.json', 'utf-8'));
    console.log('✅ Auto-Ajuda carregada com', autoajuda.ajudas.length, 'itens.');
} catch (e) {
    console.error("ERRO: Crie o arquivo autoajuda.json na raiz! Exemplo: { \"ajudas\": [{ \"chaves\": [\"travamento\"], \"resposta\": \"Dica: Reinicie o app.\", \"link\": \"https://exemplo.com\" }] }");
}

// Carrega Planos de Revenda (NOVO)
let revenda = { planos_revenda: [] };
try {
    revenda = JSON.parse(fs.readFileSync('./revenda.json', 'utf-8'));
    console.log('✅ Planos de Revenda carregados com', revenda.planos_revenda.length, 'itens.');
} catch (e) {
    console.error("ERRO: Crie o arquivo revenda.json na raiz! Exemplo: { \"planos_revenda\": [{ \"creditos\": 10, \"valor_unitario\": 13.00, \"valor_total\": 130.00 }] }");
}

// ================= MENUS =================
const MENU_PRINCIPAL = {
    title: "🤖 *Atendimento Automático*",
    text: "Olá! Seja bem-vindo.\nComo posso te ajudar hoje?",
    footer: "Selecione uma opção 👇",
    buttons: [
        { id: 'btn_renovar', text: "💲 Renovar Acesso" },
        { id: 'btn_testar',  text: "📲 Quero Testar" },
        { id: 'btn_revenda', text: "💼 Revendas" },
        { id: 'btn_suporte', text: "🆘 Falar com Suporte" }
    ]
};

const MENU_SUPORTE_SÓ = {
    title: "🤖 *Atendimento Automático*",
    text: "Desculpe, sou um robô e não compreendi sua mensagem.\n\nVocê deseja falar com um atendente humano?",
    footer: "Selecione uma opção:",
    buttons: [
        { id: 'btn_suporte', text: "🆘 Sim, Suporte" }
    ]
};

// ================= HANDLER =================
async function handleMessage(sock, jid, msg, key) {  // Adicionei 'key' aqui para resolver JID/LID
    const type = Object.keys(msg)[0];
    let text = '';
    let selectedId = null;

    if (type === 'conversation') text = msg.conversation;
    else if (type === 'extendedTextMessage') text = msg.extendedTextMessage.text;
    else if (type === 'interactiveResponseMessage') {
        try {
            const params = JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
            selectedId = params.id;
        } catch (e) {}
    }
    else if (type === 'templateButtonReplyMessage') {
        selectedId = msg.templateButtonReplyMessage.selectedId;
    }

    if (!text && !selectedId) return;

    // Nome do Cliente (PushName)
    const nomeCliente = msg.pushName || "Cliente";

    // === CHECAGEM DE MUTE ===
    const estado = getEstado(jid);
    if (estado.mute_ate > Date.now() && !text.match(/menu|oi|ola|olá|iniciar|bom|teste/i)) {
        return; // Ignora mensagens durante mute, exceto comandos de reset
    }

    // === COMANDO INICIAL OU RESET ===
    if ((text && text.match(/oi|ola|olá|menu|iniciar|bom|teste/i)) || (!selectedId && !text)) {
        atualizarEstado(jid, 0, 0); // Reseta estado
        try {
            await sock.sendMessage(jid, { 
                image: fs.readFileSync('./assets/banner.jpg'), 
                caption: "🚀" 
            });
        } catch (e) {}
        await sendButtons(sock, jid, MENU_PRINCIPAL);
        return;
    }

    // === LÓGICA DOS PLANOS (JSON) ===
    const planoSelecionado = planos.find(p => p.id === selectedId);
    if (planoSelecionado) {
        atualizarEstado(jid, 0, 0); // Reseta após ação
        await sock.sendMessage(jid, { 
            text: `✅ Escolha: *${planoSelecionado.nome}*\n💰 Valor: *${planoSelecionado.valor}*\n\nCopie o código Pix abaixo, pague e envie o comprovante:` 
        });
        await sock.sendMessage(jid, { text: planoSelecionado.pix_manual });
        return;
    }

    // === SISTEMA DE AUTO-AJUDA (COM MESMA LÓGICA DE BOTÕES VIA SEND_BUTTONS) ===
    if (text && autoajuda.ajudas.length > 0) {
        const textoLower = text.toLowerCase();
        const ajudaEncontrada = autoajuda.ajudas.find(ajuda => 
            ajuda.chaves.some(chave => textoLower.includes(chave.toLowerCase()))
        );
        if (ajudaEncontrada) {
            atualizarEstado(jid, 0, 0); // Reseta após auto-ajuda
            let msgAjuda = `💡 *Auto-Ajuda: ${ajudaEncontrada.titulo || 'Dica Rápida'}*\n\n${ajudaEncontrada.resposta}`;
            
            if (ajudaEncontrada.link) {
                // Envia texto da dica
                await sock.sendMessage(jid, { text: msgAjuda });
                
                // Usa mesma lógica: sendButtons com botão custom pra link (ID com o link encoded simples)
                const linkId = `link_${Buffer.from(ajudaEncontrada.link).toString('base64').slice(0, 20)}`; // ID curto com base64 do link
                await sendButtons(sock, jid, {
                    title: "",
                    text: "Toque abaixo para abrir o link:",
                    footer: "",
                    buttons: [
                        { id: linkId, text: "🔗 Abrir Link" }
                    ]
                });
            } else {
                // Sem link, envia só texto
                await sock.sendMessage(jid, { text: msgAjuda });
            }
            return;
        }
    }

    // === AÇÕES DO MENU (SE FOR CLIQUE EM BOTÃO) ===
    if (selectedId) {
        atualizarEstado(jid, 0, 0); // Reseta após ação válida
        
        // NOVO: Trata clique no botão de link da auto-ajuda
        if (selectedId.startsWith('link_')) {
            // Decodifica o link do ID (base64 simples)
            try {
                const fullBase64 = selectedId.replace('link_', ''); // Pega o pedaço base64
                const link = Buffer.from(fullBase64 + '===' , 'base64').toString('utf8'); // Completa padding e decodifica
                await sock.sendMessage(jid, { 
                    text: `📎 *Link para mais detalhes:*\n\n${link}\n\n_Clique ou copie para abrir._` 
                });
                // Opcional: Volta ao menu após abrir
                await sendButtons(sock, jid, MENU_PRINCIPAL);
            } catch (e) {
                console.error('Erro ao decodificar link:', e);
                await sock.sendMessage(jid, { text: "❌ Erro ao abrir link. Tente copiar do histórico." });
            }
            return;
        }
        
        switch (selectedId) {
            case 'btn_renovar':
                const botoesPlanos = planos.map(p => ({ id: p.id, text: `${p.nome} - ${p.valor}` }));
                botoesPlanos.push({ id: 'btn_voltar', text: "🔙 Voltar" });

                await sendButtons(sock, jid, {
                    title: "💎 *ESCOLHA SEU PLANO*",
                    text: "Selecione a melhor opção para você:",
                    footer: "Liberação Imediata",
                    buttons: botoesPlanos
                });
                break;

            case 'btn_testar':
                await sock.sendMessage(jid, { text: "📲 *BAIXAR APLICATIVO*\n\nBaixe e instale o app abaixo, depois me chame para liberar o teste!" });
                try {
                    await sock.sendMessage(jid, {
                        document: fs.readFileSync('./assets/aplicativo.apk'),
                        mimetype: 'application/vnd.android.package-archive',
                        fileName: 'AppVendas.apk'
                    });
                } catch (e) {
                    await sock.sendMessage(jid, { text: "⚠️ Erro: APK não encontrado na pasta assets." });
                }
                break;

            case 'btn_revenda':
                // NOVO: Envia tabela de revenda do JSON
                if (revenda.planos_revenda.length > 0) {
                    let tabela = `📊 *TABELA DE REVENDA*\n\n`;
                    tabela += `Créditos | Unitário | Total\n`;
                    tabela += `---------|----------|------\n`;
                    revenda.planos_revenda.forEach(p => {
                        tabela += `*${p.creditos}* | *R$ ${p.valor_unitario.toFixed(2)}* | *R$ ${p.valor_total.toFixed(2)}*\n`;
                    });
                    tabela += `\n*Desconto progressivo! Fale com suporte para comprar.*`;
                    await sock.sendMessage(jid, { text: tabela });
                } else {
                    await sock.sendMessage(jid, { text: "📊 *TABELA REVENDA*\n\nFale com o suporte para ver planos especiais para revendedores." });
                }
                // Volta ao menu
                await sendButtons(sock, jid, MENU_PRINCIPAL);
                break;

            case 'btn_suporte':
                // 1. Mensagem para o Cliente (estilo simples do bot antigo)
                await sock.sendMessage(jid, { 
                    text: "👨‍💻 *Atendimento Humano Solicitado*\n\nNotifiquei nosso suporte e em breve alguém entrará em contato com você neste número.\n\nPor favor, digite abaixo qual é sua dúvida para adiantar o atendimento." 
                });
                
                // 2. Resolução robusta do número (pra evitar LID bagunçado)
                let numeroLimpo = '';
                if (key && key.remoteJidAlt) {
                    numeroLimpo = key.remoteJidAlt.split('@')[0].replace(/\D/g, '');
                    console.log('Usando remoteJidAlt:', numeroLimpo);  // Debug
                } else {
                    try {
                        const contact = await sock.contactGetter.getContact(jid);
                        numeroLimpo = contact.phoneNumber ? contact.phoneNumber.replace(/\D/g, '') : '';
                        console.log('Usando contact.phoneNumber:', numeroLimpo);  // Debug
                    } catch (e) {
                        console.error('Erro ao buscar contato:', e);
                        const normalizedJid = jidNormalizedUser(jid);
                        numeroLimpo = normalizedJid.split('@')[0].replace(/\D/g, '');
                        console.log('Usando normalizedJid:', numeroLimpo);  // Debug
                    }
                }
                
                // Fallback final: split simples (como no bot antigo)
                if (!numeroLimpo) {
                    numeroLimpo = jid.split('@')[0].replace(/\D/g, '');
                    console.log('Fallback split:', numeroLimpo);  // Debug
                }
                
                // 3. Mensagem para o ADMIN (estilo simples do bot antigo: texto com +número e wa.me)
                if (ADMIN_JID) {
                    const linkWhatsApp = `https://wa.me/${numeroLimpo}`;
                    
                    await sock.sendMessage(ADMIN_JID, { 
                        text: `🔔 *NOVO CHAMADO DE SUPORTE*\n\n👤 Cliente: +${numeroLimpo}\n🔗 Link: ${linkWhatsApp}\n\n_O cliente está aguardando._` 
                    });
                }

                // Após suporte, volta ao menu principal
                await sendButtons(sock, jid, MENU_PRINCIPAL);
                break;

            case 'btn_voltar':
                await sendButtons(sock, jid, MENU_PRINCIPAL);
                break;
        }
        return;
    }

    // === FALLBACK: MENSAGEM NÃO RECONHECIDA ===
    let novoNivel = estado.nivel + 1;
    if (novoNivel === 1) {
        // Nível 1: Informa que é robô + botão suporte só
        await sendButtons(sock, jid, MENU_SUPORTE_SÓ);
        atualizarEstado(jid, 1, 0);
    } else {
        // Nível 2+: Pausa por 24h
        atualizarEstado(jid, 0, Date.now() + (24 * 60 * 60 * 1000));
        await sock.sendMessage(jid, { 
            text: "⚠️ *Atendimento Pausado*\n\nO bot foi pausado por 24 horas devido a mensagens não reconhecidas.\n\nPara reativar, envie a palavra *MENU*." 
        });
    }
}

// ================= HANDLER ANTI-LIGAÇÃO (CORRIGIDO COM SET ANTI-SPAM E REJECT SOMENTE NO PRIMEIRO RINGING) =================
const rejectedCalls = new Set();  // Global Set pra track calls rejeitadas (por ID)

function handleCall(sock) {
    sock.ev.on('call', async (calls) => {
        console.log('🔄 Evento "call" disparado! Payload:', JSON.stringify(calls, null, 2));  // DEBUG: Mostra se evento roda e o que vem
        
        for (const call of calls) {
            const callId = call.id;
            const callerJid = call.from;  // Usa call.from (LID ok)
            const status = call.status;
            
            console.log(`📞 Call details: ID=${callId}, From=${callerJid}, Status=${status}, isIncoming=${call.isIncoming || 'unknown'}`);  // DEBUG extra

            if (!call.isIncoming || rejectedCalls.has(callId)) {
                console.log('⏭️ Ignorando: Não incoming ou já rejeitada.');
                continue;
            }

            if (status === 'ringing') {
                console.log(`📞 Chamada recebida de ${callerJid} - Rejeitando...`);

                try {
                    // Rejeita a chamada
                    await sock.rejectCall(callId, callerJid);
                    rejectedCalls.add(callId);  // Marca como rejeitada
                    console.log('✅ Chamada rejeitada com sucesso.');  // DEBUG
                } catch (err) {
                    console.error('❌ Erro ao rejeitar chamada:', err);
                }

                // Envia mensagem automática (funciona com LID)
                try {
                    await sock.sendMessage(callerJid, { 
                        text: "📞 *Chamada Rejeitada*\n\nDesculpe, não aceito chamadas de voz ou vídeo. Use mensagens para atendimento rápido e eficiente! 😊" 
                    });
                    console.log('✅ Mensagem anti-chamada enviada.');  // DEBUG
                } catch (err) {
                    console.error('❌ Erro ao enviar msg anti-chamada:', err);
                }
            } else if (status === 'terminate') {
                console.log('🔚 Chamada terminada naturalmente.');
                rejectedCalls.delete(callId);  // Limpa o Set
            }
        }
    });
}

// ================= CONEXÃO =================
async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Bot Atualizado", "Chrome", "1.0"],
        syncFullHistory: true,  // ATUALIZADO: True pra full sync de eventos (inclui calls em linked devices)
        markOnlineOnConnect: false,  // Evita detecção agressiva de bot
        defaultQueryTimeoutMs: 60000  // Timeout maior para queries
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const motivo = lastDisconnect?.error?.message || 'Desconhecido';
            console.log(`🔌 Desconectado! Motivo: ${motivo} (Código: ${statusCode})`);
            isOnline = false;  // Reseta flag
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('🔄 Tentando reconectar em 5s...');
                setTimeout(start, 5000);  // Delay anti-loop
            } else {
                console.log('❌ Sessão expirada. Reescaneie o QR.');
            }
        } else if (connection === 'open') {
            if (!isOnline) {
                console.log('✅ Bot ONLINE (Fluxo Anti-Repetição + Suporte JID/LID + Auto-Ajuda + Revenda JSON + Anti-Ligação DEBUG)!');
                isOnline = true;
            }
        }
    });

    // NOVO: Adiciona o handler de chamadas
    handleCall(sock);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' && !messages[0].key.fromMe) {
            try { 
                // Passe o 'key' para o handleMessage
                await handleMessage(sock, messages[0].key.remoteJid, messages[0].message, messages[0].key); 
            }
            catch (err) { console.error("Erro:", err); }
        }
    });
}

start();