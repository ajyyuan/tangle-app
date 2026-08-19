import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path d="m3.25 8.25 3 3 6.5-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <path d="M3.75 5.25h10.5M7 2.75h4M5.25 5.25l.55 9h6.4l.55-9M7.5 8v3.5M10.5 8v3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function GripIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 12 18" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="3" cy="5" r="1" /><circle cx="9" cy="5" r="1" />
      <circle cx="3" cy="9" r="1" /><circle cx="9" cy="9" r="1" />
      <circle cx="3" cy="13" r="1" /><circle cx="9" cy="13" r="1" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <circle cx="9" cy="9" r="6.25" stroke="currentColor" strokeWidth="1.35" />
      <path d="M9 8.1v4M9 5.65h.01" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <path d="m5 5 8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

export function UndoIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <path d="M6.25 5.25 3.5 8l2.75 2.75M4 8h6.1a4.15 4.15 0 0 1 4.15 4.15" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function RedoIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <path d="m11.75 5.25 2.75 2.75-2.75 2.75M14 8H7.9a4.15 4.15 0 0 0-4.15 4.15" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrangeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <rect x="2.5" y="3" width="4.5" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="11" y="7.25" width="4.5" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="11.5" width="4.5" height="3.5" rx="1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.25 4.75h1.1c.9 0 1.65.75 1.65 1.65v3.2c0 .9-.75 1.65-1.65 1.65h-1.1M10 9h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <circle cx="9" cy="9" r="2.25" stroke="currentColor" strokeWidth="1.35" />
      <path d="M9 2.5v1.25M9 14.25v1.25M15.5 9h-1.25M3.75 9H2.5M13.6 4.4l-.9.9M5.3 12.7l-.9.9M13.6 13.6l-.9-.9M5.3 5.3l-.9-.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="9" cy="9" r="5.1" stroke="currentColor" strokeWidth="1.15" strokeDasharray="1.4 2.1" />
    </svg>
  );
}

export function AppearanceIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <circle cx="9" cy="9" r="6.15" stroke="currentColor" strokeWidth="1.35" />
      <path d="M9 2.85a6.15 6.15 0 0 0 0 12.3V2.85Z" fill="currentColor" opacity=".28" />
      <path d="M9 2.85v12.3" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path d="m5.75 3.5 4.5 4.5-4.5 4.5" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" {...props}>
      <rect x="2.5" y="3" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M7 3.5v11" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}
