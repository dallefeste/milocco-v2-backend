/**
 * Ruoli applicativi.
 * - ADMIN: amministrazione completa, anagrafiche, utenti e impostazioni.
 * - OFFICE: ufficio, inserimento e gestione ordini, preventivi e pianificazione.
 * - TABLET: dispositivo di reparto, solo le funzioni dell'app tablet.
 */
export const USER_ROLES = ['ADMIN', 'OFFICE', 'TABLET'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Amministratore',
  OFFICE: 'Ufficio',
  TABLET: 'Tablet di reparto',
};
