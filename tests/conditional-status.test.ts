import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCopartConditionalPageText,
  normalizePageText,
  parseCopartAuctionDates,
} from '../src/scheduler/copart-conditional-status.js';

test('normaliza acentos e espaços da página Copart', () => {
  assert.equal(normalizePageText('Venda Finalizada\n  Terça'), 'VENDA FINALIZADA TERCA');
});

test('extrai data e hora BRT do bloco da venda', () => {
  const [date] = parseCopartAuctionDates('Data da Venda: Terça | 25.08.2026 | 14:30 BRT');
  assert.ok(date);
  assert.equal(date.toISOString(), '2026-08-25T17:30:00.000Z');
});

test('extrai mais de uma data sem duplicar entradas', () => {
  const dates = parseCopartAuctionDates('18.08.2026 | 15:47 BRT · Terça | 25.08.2026 | 14:30 BRT');
  assert.equal(dates.length, 2);
});

test('classifica aprovação quando a venda finaliza sem nova data', () => {
  const result = classifyCopartConditionalPageText(
    'Venda Finalizada · Data da Venda: Terça | 18.08.2026 | 15:47 BRT',
    new Date('2026-08-18T18:47:00.000Z'),
  );
  assert.equal(result.status, 'approved');
});

test('classifica recusa quando a data avança e o lote volta a aceitar lance', () => {
  const result = classifyCopartConditionalPageText(
    'Dar Lance Agora · Terça | 25.08.2026 | 14:30 BRT',
    new Date('2026-08-18T18:47:00.000Z'),
  );
  assert.equal(result.status, 'refused');
  assert.equal(result.nextAuctionDate?.toISOString(), '2026-08-25T17:30:00.000Z');
});
