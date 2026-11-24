/**
 * Answers one btw side question into a card of the btw window. Shared by `@btw`
 * in the chat and the window's own input (which never waits for the chat).
 */
import * as vscode from 'vscode';
import { noModelMarkdown, pickIncludedModel } from '../chat/lm';
import { streamBtwAnswer } from './answer';
import { BtwCardHandle } from './answersPanel';
import { describeBtwContext, gatherBtwContext } from './context';
import { BtwModelSource, btwMode, modelSourceLabel, resolveBtwModel } from './model';

export type BtwRunOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  /** No free model (included mode); the card explains it and offers the settings. */
  | { kind: 'noModel' }
  | { kind: 'error'; message: string };

export interface BtwRunOptions {
  /** The model selected in the chat picker (`request.model` of @btw). */
  chatModel?: vscode.LanguageModelChat;
  /** Formatted #file / #selection references. */
  references?: string[];
}

export async function runBtwQuestion(
  ext: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  card: BtwCardHandle,
  question: string,
  opts: BtwRunOptions = {},
): Promise<BtwRunOutcome> {
  try {
    const ctx = await gatherBtwContext(ext, { log: (m) => log.info(m) });
    if (opts.references?.length) {
      ctx.references = opts.references;
    }
    const contextLabel = describeBtwContext(ctx);
    card.update({ context: contextLabel });
    if (card.token.isCancellationRequested) {
      card.finish('cancelled');
      return { kind: 'cancelled' };
    }

    // Pick the model.
    let model: vscode.LanguageModelChat;
    let source: BtwModelSource;
    if (btwMode() === 'included') {
      const pick = await pickIncludedModel();
      if (pick.kind === 'error') {
        card.finish('error', pick.message);
        return { kind: 'error', message: pick.message };
      }
      if (pick.kind === 'none') {
        card.update({ fix: 'openSettings' });
        card.setAnswer(noModelMarkdown(pick.families));
        card.finish('noModel');
        return { kind: 'noModel' };
      }
      model = pick.model;
      source = 'included';
    } else if (opts.chatModel) {
      model = opts.chatModel;
      source = 'chat';
    } else {
      // Panel input (or old VS Code): the model of the working chat session, the
      // model btw used before, or ask once.
      const pick = await resolveBtwModel(ext, ctx.chatModelId, (m) => log.info(m));
      if (pick.kind !== 'ok') {
        const message =
          pick.kind === 'error' ? pick.message : vscode.l10n.t('No model chosen, so btw did not answer. Choose a model and try again.');
        card.finish('error', message);
        return { kind: 'error', message };
      }
      model = pick.model;
      source = pick.source;
    }
    if (card.token.isCancellationRequested) {
      card.finish('cancelled');
      return { kind: 'cancelled' };
    }

    card.update({ model: model.name, modelNote: modelSourceLabel(source), status: 'streaming' });
    log.info(`btw: asking ${model.name} (${model.family}, ${source}) · context: ${contextLabel}`);
    const res = await streamBtwAnswer(model, question, ctx, (fragment) => card.append(fragment), card.token);
    if (res.kind === 'error') {
      log.warn(`btw: ${res.message}`);
      card.finish('error', res.message);
      return res;
    }
    card.finish(res.kind === 'cancelled' ? 'cancelled' : 'done');
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`btw: ${message}`);
    card.finish('error', message);
    return { kind: 'error', message };
  }
}
