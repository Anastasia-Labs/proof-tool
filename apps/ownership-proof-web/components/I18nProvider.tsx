"use client";

import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AppLocale } from "../lib/i18n/locales";
import { localizedPath } from "../lib/i18n/locales";
import { translateJapanese } from "../lib/i18n/messages-ja";

const LocaleContext = createContext<AppLocale>("en");

export function I18nProvider({ locale, children }: { locale: AppLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useAppLocale(): AppLocale {
  return useContext(LocaleContext);
}

export function useLocalizedPath(): (path: string) => string {
  const locale = useAppLocale();
  return (path) => localizedPath(locale, path);
}

export function Localize({ children }: { children: ReactNode }) {
  const locale = useAppLocale();
  return <>{localizeNode(locale, children)}</>;
}

export function localizeText(locale: AppLocale, value: string): string {
  if (locale !== "ja") {
    return value;
  }
  const core = value.trim();
  if (!core) {
    return value;
  }
  const translated = translateJapanese(core);
  if (translated === core) {
    return value;
  }
  const leadingWhitespace = value.match(/^\s*/u)?.[0] ?? "";
  const trailingWhitespace = value.match(/\s*$/u)?.[0] ?? "";
  return `${leadingWhitespace}${translated}${trailingWhitespace}`;
}

function localizeNode(locale: AppLocale, node: ReactNode): ReactNode {
  if (locale === "en" || node === null || node === undefined || typeof node === "boolean") {
    return node;
  }
  if (typeof node === "string") {
    return localizeText(locale, node);
  }
  if (typeof node === "number" || typeof node === "bigint") {
    return node;
  }
  if (Array.isArray(node)) {
    return Children.map(node, (child) => localizeNode(locale, child));
  }
  if (!isValidElement(node)) {
    return node;
  }

  const element = node as ReactElement<Record<string, unknown>>;
  const nextProps = localizeProps(locale, element.props);
  const children = element.props.children as ReactNode;
  if (children === undefined) {
    return cloneElement(element, nextProps);
  }
  return cloneElement(element, nextProps, localizeNode(locale, children));
}

function localizeProps(locale: AppLocale, props: Record<string, unknown>): Record<string, unknown> {
  const localized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      continue;
    }
    localized[key] = localizePropValue(locale, value);
  }
  return localized;
}

function localizePropValue(locale: AppLocale, value: unknown): unknown {
  if (typeof value === "string") {
    return localizeText(locale, value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => localizePropValue(locale, entry));
  }
  if (isValidElement(value)) {
    return localizeNode(locale, value);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localizePropValue(locale, entry)]));
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
