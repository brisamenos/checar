// server.js — Proxy PIX PagSeguro para EvoCRM
// Deploy no Easypanel como aplicação Node.js

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
app.use(cors());
app.use(express.json());

// ============================================================
// ⚙️ CONFIGURAÇÕES — edite aqui ou use variáveis de ambiente
// ============================================================
const CONFIG = {
    PORT:       process.env.PORT       || 3000,
    PS_TOKEN:   process.env.PS_TOKEN   || '1218B0CE3A3A81B004BF8F8AA16AB597',
    PS_EMAIL:   process.env.PS_EMAIL   || 'SEU_EMAIL_PAGSEGURO',
    SB_URL:     process.env.SB_URL     || 'https://qhnbisjogpdoyszpsucs.supabase.co',
    SB_KEY:     process.env.SB_KEY     || 'sb_publishable_3PAly_BCdvoldAzm1Y7SxQ_S3rp2QhQ',
    SB_SERVICE: process.env.SB_SERVICE || 'SUA_SERVICE_ROLE_KEY', // ← Supabase → Settings → API → service_role
};

const sb = createClient(CONFIG.SB_URL, CONFIG.SB_SERVICE);

// ============================================================
// ROTA: Gerar PIX
// POST /gerar-pix
// ============================================================
app.post('/gerar-pix', async (req, res) => {
    try {
        const { pedido_id, nome, email, cpf, valor, descricao, instancia, license_key } = req.body;

        if (!pedido_id || !valor) {
            return res.status(400).json({ error: 'Campos obrigatórios: pedido_id, valor' });
        }

        // Chama API do PagSeguro
        const params = new URLSearchParams({
            email:                    CONFIG.PS_EMAIL,
            token:                    CONFIG.PS_TOKEN,
            paymentMethod:            'pix',
            receiverEmail:            CONFIG.PS_EMAIL,
            currency:                 'BRL',
            itemId1:                  '1',
            itemDescription1:         descricao || 'EvoCRM Pro',
            itemAmount1:              Number(valor).toFixed(2),
            itemQuantity1:            '1',
            senderName:               nome || 'Cliente',
            senderEmail:              email || 'cliente@email.com',
            senderCPF:                (cpf || '00000000000').replace(/\D/g, '').padStart(11, '0'),
            shippingAddressRequired:  'false',
            reference:                pedido_id,
        });

        const psRes = await fetch('https://ws.pagseguro.uol.com.br/v2/checkout', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=ISO-8859-1' },
            body:    params.toString(),
        });

        const psText = await psRes.text();
        console.log('PagSeguro response:', psText.substring(0, 500));

        // Verifica erro do PagSeguro
        if (psText.includes('<error>') || psText.includes('<errors>')) {
            const msgMatch = psText.match(/<message>([^<]+)<\/message>/);
            throw new Error('PagSeguro: ' + (msgMatch?.[1] || 'Erro desconhecido'));
        }

        // Extrai dados do XML de resposta
        const codeMatch    = psText.match(/<code>([^<]+)<\/code>/);
        const pixQrMatch   = psText.match(/<pixQrCode>([^<]+)<\/pixQrCode>/);
        const pixCopyMatch = psText.match(/<pixCopiaCola>([^<]+)<\/pixCopiaCola>/);

        const transactionCode = codeMatch?.[1]    || '';
        const pixCopiaCola    = pixCopyMatch?.[1] || pixQrMatch?.[1] || '';

        if (!pixCopiaCola) {
            throw new Error('PIX não retornado. Verifique se sua conta PagSeguro tem PIX habilitado.');
        }

        // Salva o código da transação no Supabase
        if (transactionCode) {
            await sb.from('pagamentos').update({
                mp_preference_id: transactionCode,
            }).eq('id', pedido_id);
        }

        return res.json({
            pix_copia_cola:   pixCopiaCola,
            transaction_code: transactionCode,
        });

    } catch (e) {
        console.error('Erro /gerar-pix:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

// ============================================================
// ROTA: Webhook PagSeguro (notificação de pagamento)
// POST /ps-webhook
// Configure no PagSeguro: Minha Conta → Preferências → Notificações
// URL: https://SEU_SERVER/ps-webhook
// ============================================================
app.post('/ps-webhook', async (req, res) => {
    try {
        const { notificationCode, notificationType } = req.body;

        if (notificationType !== 'transaction') {
            return res.sendStatus(200);
        }

        // Busca detalhes da transação no PagSeguro
        const detailRes = await fetch(
            `https://ws.pagseguro.uol.com.br/v3/transactions/notifications/${notificationCode}?email=${CONFIG.PS_EMAIL}&token=${CONFIG.PS_TOKEN}`
        );
        const detailXml = await detailRes.text();
        console.log('PS Webhook:', detailXml.substring(0, 500));

        // Extrai dados do XML
        const statusMatch    = detailXml.match(/<status>(\d)<\/status>/);
        const referenceMatch = detailXml.match(/<reference>([^<]+)<\/reference>/);

        const psStatus  = parseInt(statusMatch?.[1]  || '0');
        const pedidoId  = referenceMatch?.[1] || '';

        if (!pedidoId) return res.sendStatus(200);

        // Status do PagSeguro:
        // 1=Aguardando, 2=Em análise, 3=Paga, 4=Disponível, 5=Contestação, 6=Devolvida, 7=Cancelada, 9=Risco de chargeback
        const statusMap = {
            3: 'approved',
            4: 'approved',
            6: 'cancelled',
            7: 'cancelled',
        };
        const novoStatus = statusMap[psStatus];

        if (!novoStatus) return res.sendStatus(200); // Status intermediário, ignora

        // Atualiza status no Supabase
        await sb.from('pagamentos').update({ status: novoStatus }).eq('id', pedidoId);

        // Se aprovado, ativa a licença
        if (novoStatus === 'approved') {
            const { data: pag } = await sb.from('pagamentos').select('*').eq('id', pedidoId).single();

            if (pag) {
                const dias    = pag.billing === 'anual' ? 365 : 30;
                const expires = new Date();
                expires.setDate(expires.getDate() + dias);

                const planoMap = { starter: 'basico', pro: 'premium', enterprise: 'platinum' };

                await sb.from('licenses').upsert({
                    instance_name: pag.instancia,
                    license_key:   pag.license_key || ('LIC-' + Math.random().toString(36).substr(2, 9).toUpperCase()),
                    status:        'active',
                    plano:         planoMap[pag.plano] || 'basico',
                    expires_at:    expires.toISOString(),
                    is_trial:      false,
                }, { onConflict: 'instance_name' });

                await sb.from('pagamentos').update({ expires_at: expires.toISOString() }).eq('id', pedidoId);

                console.log(`✅ Licença ativada: ${pag.instancia}`);
            }
        }

        return res.sendStatus(200);

    } catch (e) {
        console.error('Erro /ps-webhook:', e.message);
        return res.sendStatus(500);
    }
});

// ============================================================
// ROTA: Health check
// ============================================================
app.get('/', (req, res) => {
    res.json({ status: 'EvoCRM PIX Server rodando ✅', version: '1.0.0' });
});

app.listen(CONFIG.PORT, () => {
    console.log(`🚀 EvoCRM PIX Server rodando na porta ${CONFIG.PORT}`);
});
