// The account book on a team tab. Inline edit, flags on rows and numbers, never on a name.
import { S, wk, memberById } from '../data/store.js';
import { esc, money, validDate, fmtDate, daysBetween } from '../lib/format.js';
import { bookIssues, bookFlag, sum } from '../lib/rules.js';

export function canEditAccount(a) {
  if (S.admin) return true;
  if (!S.me || !S.me.active) return false;
  if (S.me.role === 'leader') return true;
  return a.owner_member_id === S.me.id;
}

export function renderBook(rep, key) {
  const cfg = S.cfg, bk = cfg.book, w = wk();
  const f = S.filters, fk = (k) => f[`${key}_${k}`] || '';
  const all = Object.values(S.accounts).filter((a) => a.owner_member_id === rep.id);
  const flagged = all.filter((a) => bookIssues(cfg, a, w.today).length);
  let rows = fk('flag') === 'risk' ? flagged : all;
  const fo = { r: 0, y: 1, g: 2 };
  rows = [...rows].sort((a, b) => fo[bookFlag(cfg, a, w.today)] - fo[bookFlag(cfg, b, w.today)] || (+b.annual_value || 0) - (+a.annual_value || 0));

  const lvl = (v) => bk.levels.find((l) => l.value === v);
  const opt = (v, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`;
  const since = (d) => (validDate(d) ? `${daysBetween(d, w.today)}d ago` : '');

  const body = rows.map((a) => {
    const iss = bookIssues(cfg, a, w.today);
    const ro = canEditAccount(a) ? '' : 'disabled';
    const at = (k) => `${ro} data-acct="${esc(a.id)}" data-k="${k}"`;
    const miss = (k) => { const i = iss.filter((x) => x.f === k); return i.some((x) => x.sev === 'r') ? 'miss' : i.length ? 'warn' : ''; };
    const l = lvl(a.satisfaction);
    return `<tr data-acct-row="${esc(a.id)}">
      <td><span class="dot ${bookFlag(cfg, a, w.today)}" title="${esc(iss.map((i) => i.t).join(' · '))}"></span></td>
      <td class="acct"><input class="ed acctname" ${at('property')} value="${esc(a.property)}" aria-label="Property"></td>
      <td class="num"><input class="ed num" ${at('annual_value')} data-type="num" inputmode="decimal" value="${+a.annual_value ? Math.round(+a.annual_value) : ''}" placeholder="$"></td>
      <td><span class="dot ${l ? l.color : 'n'}"></span> <select class="ed ${miss('satisfaction')}" ${at('satisfaction')} aria-label="Satisfaction">${a.satisfaction ? '' : '<option value=""></option>'}${bk.levels.map((x) => opt(x.value, a.satisfaction)).join('')}</select></td>
      <td><input class="ed date ${miss('last_audit')}" type="date" ${at('last_audit')} value="${validDate(a.last_audit) ? a.last_audit : ''}"><small class="m"> ${since(a.last_audit)}</small></td>
      <td><input class="ed date" type="date" ${at('last_meeting')} value="${validDate(a.last_meeting) ? a.last_meeting : ''}"><small class="m"> ${since(a.last_meeting)}</small></td>
      <td><input class="ed date" type="date" ${at('next_meeting')} value="${validDate(a.next_meeting) ? a.next_meeting : ''}"></td>
      <td><input class="ed txt" style="width:150px" ${at('contact_name')} value="${esc(a.contact_name || '')}" placeholder="name" aria-label="Contact name"></td>
      <td><input class="ed txt" style="width:190px" type="email" ${at('contact_email')} value="${esc(a.contact_email || '')}" placeholder="email" aria-label="Contact email"></td>
      <td><input class="ed short" style="width:130px" type="tel" ${at('contact_phone')} value="${esc(a.contact_phone || '')}" placeholder="phone" aria-label="Contact phone"></td>
      <td><input class="ed txt" ${at('notes')} value="${esc(a.notes || '')}" aria-label="Notes"></td>
    </tr>`;
  }).join('');

  return `
  <div class="sec">
    <div class="sec-h"><h2 class="s16">${esc(bk.label)} · ${all.length} accounts · ${money(sum(all, (a) => +a.annual_value || 0))}</h2>
      <div class="bar tight">
        <span class="pill ${flagged.length ? 'y' : 'g'}">${flagged.length} need attention</span>
        <select class="ed" data-f="${key}_flag"><option value="">Show: all</option><option value="risk" ${fk('flag') === 'risk' ? 'selected' : ''}>Show: needs attention</option></select>
      </div></div>
    ${rows.length ? `<div class="tw"><table><thead><tr><th></th><th>Property</th><th class="num">Annual $</th><th>Satisfaction</th><th>Last audit</th><th>Last meeting</th><th>Next meeting</th><th>Contact</th><th>Email</th><th>Phone</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table></div>`
      : `<div class="card empty">${all.length ? 'Nothing needs attention. Nice.' : 'No accounts in this book yet.'}</div>`}
    <p class="note">Red: satisfaction ${esc(bk.levels.filter((l) => l.color === 'r').map((l) => l.value).join('/') || 'red')} or last audit over ${bk.audit_days} days. Yellow: satisfaction ${esc(bk.levels.filter((l) => l.color === 'y').map((l) => l.value).join('/') || 'yellow')} or no audit on record.${bk.note ? ' ' + esc(bk.note) : ''}</p>
  </div>`;
}

// Summit tiles for the book, from the summit tab's "tiles" config
export function bookTile(t, accounts, today) {
  const cfg = S.cfg;
  if (!cfg.book) return '';
  const total = sum(accounts, (a) => +a.annual_value || 0);
  const risky = accounts.filter((a) => bookIssues(cfg, a, today).length);
  const tile = (l, v, s) => `<div class="tile"><span class="stripe"></span><div class="l">${esc(l)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  if (t.type === 'book_value') return tile(t.label, money(total), `${accounts.length} accounts · annual`);
  if (t.type === 'book_at_risk') {
    const overdue = risky.filter((a) => bookIssues(cfg, a, today).some((i) => i.f === 'last_audit')).length;
    const sat = risky.filter((a) => bookIssues(cfg, a, today).some((i) => i.f === 'satisfaction')).length;
    return tile(t.label, `${risky.length} <small>/ ${accounts.length}</small>`, `${money(sum(risky, (a) => +a.annual_value || 0))} annual · ${overdue} audit · ${sat} satisfaction`);
  }
  return '';
}
export { fmtDate, memberById };
