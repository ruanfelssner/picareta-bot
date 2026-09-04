import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCopartLotDetails,
  classifyCopartConditionalPageText,
  normalizePageText,
  parseCopartAuctionDates,
  shouldAutoApproveConditional,
} from '../src/scheduler/copart-conditional-status.js';

test('classifica como aprovada usando o endpoint estrutural de detalhes da Copart', () => {
  const result = classifyCopartLotDetails({
    lss: 'Sold',
    lotSoldFlag: true,
    gr: 'Vendido/Expedido',
    currBid: 9700,
    ad: 1786118400000,
  }, new Date('2026-08-07T16:00:00.000Z'));

  assert.equal(result?.status, 'approved');
  assert.equal(result?.statusRaw, 'Venda Finalizada');
});

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

test('classifica aprovação quando a Copart mostra apenas resultado da condicional finalizado', () => {
  const result = classifyCopartConditionalPageText(
    'Resultado da condicional: Finalizado. Data da venda: 04.08.2026 | 13:30 BRT',
    new Date('2026-08-04T13:30:00-03:00'),
  );

  assert.equal(result.status, 'approved');
});

test('confirma a condicional após três dias sem nova data', () => {
  assert.equal(
    shouldAutoApproveConditional(
      new Date('2026-08-07T16:00:00.000Z'),
      null,
      new Date('2026-08-10T16:00:00.000Z'),
    ),
    true,
  );
  assert.equal(
    shouldAutoApproveConditional(
      new Date('2026-08-07T16:00:00.000Z'),
      new Date('2026-08-25T17:30:00.000Z'),
      new Date('2026-08-25T12:00:00.000Z'),
    ),
    false,
  );
});

test('não aprova a condicional antes de completar três dias', () => {
  assert.equal(
    shouldAutoApproveConditional(
      new Date('2026-08-07T16:00:00.000Z'),
      null,
      new Date('2026-08-10T15:59:59.000Z'),
    ),
    false,
  );
});

test('venda finalizada antes da janela de três dias permanece pendente', () => {
  const result = classifyCopartConditionalPageText(
    'Venda Finalizada · Data da Venda: 08.08.2026 | 15:47 BRT',
    new Date('2026-08-08T18:47:00.000Z'),
    new Date('2026-08-10T18:46:59.000Z'),
  );

  assert.equal(result.status, 'pending');
});

test('classifica lote inexistente como removido', () => {
  const result = classifyCopartConditionalPageText(
    'Lote não existe ou foi removido da Copart',
    new Date('2026-08-08T18:47:00.000Z'),
  );

  assert.equal(result.status, 'removed');
  assert.equal(result.statusRaw, 'Lote removido ou indisponível');
});

test('classifica recusa quando a data avança e o lote volta a aceitar lance', () => {
  const result = classifyCopartConditionalPageText(
    'Dar Lance Agora · Terça | 25.08.2026 | 14:30 BRT',
    new Date('2026-08-18T18:47:00.000Z'),
  );
  assert.equal(result.status, 'refused');
  assert.equal(result.nextAuctionDate?.toISOString(), '2026-08-25T17:30:00.000Z');
});
