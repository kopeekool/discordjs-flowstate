import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  type APISelectMenuOption,
  type MessageActionRowComponentBuilder,
  type ModalActionRowComponentBuilder,
} from "discord.js";

import { encodeCustomId } from "../utils/customId.js";

/**
 * Helpers for constructing flowstate-aware components without manually
 * encoding customIds. Every builder accepts the `flowId` and `executionId`
 * automatically wired by {@link FlowMachine.button}/{@link FlowMachine.select}
 * etc., so application code stays focused on intent.
 *
 * The helpers also work standalone — pass `flowId`/`executionId` explicitly if
 * you ever need to assemble components outside of a `render()` callback.
 */

export interface ButtonOptions {
  trigger: string;
  label?: string;
  style?: ButtonStyle;
  emoji?: string;
  disabled?: boolean;
  /** Set to make the button a link button. `trigger` is ignored when set. */
  url?: string;
}

export function buildButton(
  flowId: string,
  executionId: string,
  options: ButtonOptions,
): ButtonBuilder {
  const button = new ButtonBuilder().setStyle(options.style ?? ButtonStyle.Secondary);
  if (options.label) button.setLabel(options.label);
  if (options.emoji) button.setEmoji(options.emoji);
  if (options.disabled) button.setDisabled(true);
  if (options.url) {
    button.setStyle(ButtonStyle.Link).setURL(options.url);
  } else {
    button.setCustomId(encodeCustomId(flowId, executionId, options.trigger));
  }
  return button;
}

export interface SelectOptions {
  trigger: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
  options: Array<
    | StringSelectMenuOptionBuilder
    | (Omit<APISelectMenuOption, "default"> & { default?: boolean })
  >;
}

export function buildSelect(
  flowId: string,
  executionId: string,
  options: SelectOptions,
): StringSelectMenuBuilder {
  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeCustomId(flowId, executionId, options.trigger))
    .addOptions(
      options.options.map((opt) =>
        opt instanceof StringSelectMenuOptionBuilder
          ? opt
          : new StringSelectMenuOptionBuilder()
              .setLabel(opt.label)
              .setValue(opt.value)
              .setDefault(opt.default ?? false)
              .setDescription(opt.description ?? "")
              .setEmoji(opt.emoji ?? { name: "" }),
      ),
    );
  if (options.placeholder) select.setPlaceholder(options.placeholder);
  if (options.minValues !== undefined) select.setMinValues(options.minValues);
  if (options.maxValues !== undefined) select.setMaxValues(options.maxValues);
  if (options.disabled) select.setDisabled(true);
  return select;
}

export interface ModalFieldOptions {
  customId: string;
  label: string;
  style?: TextInputStyle;
  placeholder?: string;
  value?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface ModalOptions {
  trigger: string;
  title: string;
  fields: ModalFieldOptions[];
}

export function buildModal(
  flowId: string,
  executionId: string,
  options: ModalOptions,
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(encodeCustomId(flowId, executionId, options.trigger))
    .setTitle(options.title);

  for (const field of options.fields) {
    const input = new TextInputBuilder()
      .setCustomId(field.customId)
      .setLabel(field.label)
      .setStyle(field.style ?? TextInputStyle.Short)
      .setRequired(field.required ?? true);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (field.value !== undefined) input.setValue(field.value);
    if (field.minLength !== undefined) input.setMinLength(field.minLength);
    if (field.maxLength !== undefined) input.setMaxLength(field.maxLength);
    modal.addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(input),
    );
  }
  return modal;
}

/**
 * Helper that wraps a list of message components into one or more action rows,
 * respecting Discord's "one select per row, max five buttons per row" rules.
 */
export function rows(
  ...components: MessageActionRowComponentBuilder[]
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const result: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let currentButtons: ButtonBuilder[] = [];

  const flushButtons = (): void => {
    if (currentButtons.length === 0) return;
    result.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...currentButtons,
      ),
    );
    currentButtons = [];
  };

  for (const component of components) {
    if (component instanceof ButtonBuilder) {
      currentButtons.push(component);
      if (currentButtons.length === 5) flushButtons();
    } else {
      flushButtons();
      result.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          component,
        ),
      );
    }
  }
  flushButtons();
  return result;
}
