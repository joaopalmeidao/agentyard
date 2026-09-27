// Configuração do checkout do Paddle. Preencha depois de criar os produtos no painel do Paddle
// (Catalog → Products → preços começam com "pri_"; Developer tools → Authentication → client-side token).
// Enquanto o token estiver vazio, os botões de compra aparecem desativados.
const PADDLE = {
  environment: 'sandbox',   // 'sandbox' para testar, 'production' quando a conta for aprovada
  token: '',                // client-side token: test_... (sandbox) ou live_... (produção)
  prices: {
    pro:   { monthly: '', yearly: '' },
    times: { yearly: '' },   // Times só tem cobrança anual, por pessoa
  },
};

let billing = 'monthly';

function priceId(plan) {
  const p = PADDLE.prices[plan];
  return p && (p[billing] || (plan === 'times' ? p.yearly : ''));
}

function setBilling(value) {
  billing = value;
  document.querySelectorAll('.billing button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.billing === value)));
  document.querySelectorAll('[data-monthly]').forEach(el => { el.textContent = el.dataset[value]; });
  refreshButtons();
}

function refreshButtons() {
  const ready = !!(PADDLE.token && window.Paddle);
  document.querySelectorAll('[data-plan]').forEach(btn => {
    const ok = ready && !!priceId(btn.dataset.plan);
    btn.disabled = !ok;
    btn.title = ok ? '' : 'Compra ainda não disponível';
  });
}

document.querySelectorAll('.billing button').forEach(b => b.addEventListener('click', () => setBilling(b.dataset.billing)));

document.querySelectorAll('[data-plan]').forEach(btn => btn.addEventListener('click', () => {
  const id = priceId(btn.dataset.plan);
  if (!id || !window.Paddle) return;
  window.Paddle.Checkout.open({ items: [{ priceId: id, quantity: 1 }] });
}));

if (PADDLE.token && window.Paddle) {
  if (PADDLE.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
  window.Paddle.Initialize({ token: PADDLE.token });
}
refreshButtons();
