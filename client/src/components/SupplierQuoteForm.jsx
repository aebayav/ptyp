import { useState } from 'react';
import { CURRENCIES } from '../utils';

// Satıcı portalı için ortak teklif formu (yeni/mevcut teklif)
export default function SupplierQuoteForm({ initial, onCancel, onSubmit }) {
  const [form, setForm] = useState({
    price: initial && initial.price != null ? String(initial.price) : '',
    currency: initial?.currency || 'TRY',
    delivery_days: initial?.delivery_days != null ? String(initial.delivery_days) : '',
    validity_date: initial?.validity_date || '',
    notes: initial?.notes || '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (f) => (e) => setForm((s) => ({ ...s, [f]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        price: Number(form.price),
        currency: form.currency,
        delivery_days: form.delivery_days === '' ? null : Number(form.delivery_days),
        validity_date: form.validity_date,
        notes: form.notes,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-row">
        <div className="field">
          <label>Fiyat *</label>
          <input type="number" min="0" step="any" value={form.price} onChange={set('price')} required autoFocus placeholder="0,00" />
        </div>
        <div className="field">
          <label>Para Birimi</label>
          <select value={form.currency} onChange={set('currency')}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>{c === 'TRY' ? '₺ TRY' : c === 'USD' ? '$ USD' : '€ EUR'}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label>Teslim Süresi (gün)</label>
          <input type="number" min="0" value={form.delivery_days} onChange={set('delivery_days')} placeholder="Örn: 30" />
        </div>
        <div className="field">
          <label>Geçerlilik Tarihi</label>
          <input type="date" value={form.validity_date} onChange={set('validity_date')} />
        </div>
      </div>
      <div className="field">
        <label>Not</label>
        <textarea value={form.notes} onChange={set('notes')} placeholder="Ödeme koşulu, nakliye dahil mi, iskonto vb." />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>Vazgeç</button>
        <button type="submit" className="btn btn-accent" disabled={busy}>
          {busy ? 'Kaydediliyor…' : 'Teklifi Gönder'}
        </button>
      </div>
    </form>
  );
}
