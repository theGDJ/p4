/**
 * English copy. This object is the shape contract: `hi.ts` is typed as
 * `typeof en`, so a missing or mis-typed Hindi string fails the build rather than
 * silently rendering a key at runtime.
 */
export const en = {
  common: {
    appName: 'BIS-Saathi',
    tagline: 'Indian Standards, with sources you can check',
    disclaimer: 'Informational — verify against current official sources',
    loading: 'Loading…',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    saved: 'Saved',
    back: 'Back',
    next: 'Next',
    language: 'Language',
    english: 'English',
    hindi: 'हिन्दी',
    skipToContent: 'Skip to main content',
    verified: 'Verified',
    unverified: 'Not yet verified',
    restricted: 'Restricted — metadata only',
    outdated: 'Outdated',
    superseded: 'Superseded',
    optional: 'optional',
    required: 'required',
  },

  nav: {
    home: 'Home',
    chat: 'Ask the assistant',
    newChat: 'New chat',
    conversations: 'Your chats',
    dashboard: 'Dashboard',
    savedStandards: 'Saved standards',
    admin: 'Administration',
    knowledge: 'Knowledge base',
    signIn: 'Sign in',
    signOut: 'Sign out',
    register: 'Create account',
    account: 'Account',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    toggleSidebar: 'Toggle conversation list',
  },

  landing: {
    headline: 'Ask about Indian Standards. Get answers that show their sources.',
    subheadline:
      'BIS-Saathi answers only from an approved knowledge base of official BIS material, and cites the document, clause and link behind every claim. If the evidence is not there, it says so instead of guessing.',
    assistantHeading: 'Ask your question',
    assistantLabel: 'Ask BIS-Saathi',
    assistantPlaceholder: 'e.g. Which Indian Standard applies to drinking water in a bottle?',
    askButton: 'Ask',
    signInToAsk: 'Sign in to ask',
    exampleQuestionsTitle: 'Try one of these',
    examples: [
      'Which Indian Standard applies to drinking water?',
      'What does the BIS hallmark on gold jewellery indicate?',
      'What are the steps to apply for a BIS licence?',
      'मेरे उत्पाद के लिए कौन सा मानक लागू होता है?',
    ],
    capabilitiesTitle: 'What it can help with',
    capabilities: [
      {
        title: 'Standards lookup',
        body: 'Find which Indian Standard or Quality Control Order may apply to a product, with the clause and source shown.',
      },
      {
        title: 'Certification guidance',
        body: 'Walk through the steps, documents and pathways described in official BIS material — with no fees or timelines unless a source states them.',
      },
      {
        title: 'Hallmarking explained',
        body: 'Plain-language answers about hallmarking and purity marking, plus pointers to official verification channels.',
      },
      {
        title: 'Bilingual',
        body: 'Ask in English or Hindi. Hindi questions retrieve English sources too, and answers come back in your language.',
      },
    ],
    trustTitle: 'How the evidence works',
    trustPoints: [
      'Every factual claim carries a citation to an approved document, section and link.',
      'Citations are validated on the server. A reference that is not in the retrieved set is removed, not displayed.',
      'Each source shows its verification status and when it was last checked.',
      'When the knowledge base cannot answer, you get an exact "insufficient information" reply and a pointer to an official channel.',
      'Answers are labelled with an evidence tier — strong, partial, or none — computed by rule, never by the model rating itself.',
    ],
    honestyTitle: 'What this tool is not',
    honestyPoints: [
      'It does not certify, approve or decide anything. Recommendations are informational.',
      'It cannot confirm whether a hallmark or licence is genuine — use the official BIS channels for that.',
      'Coverage is limited to the documents that have been ingested and approved. It is not a complete library of Indian Standards.',
      'Restricted standards are listed as metadata only; full text is never reproduced.',
    ],
    knowledgeStatus: 'Knowledge base status',
    approvedDocuments: 'approved documents',
    approvedChunks: 'approved passages',
    emptyKnowledgeNote:
      'The knowledge base is empty in this deployment, so every question returns the "insufficient information" reply. That is the correct behaviour, not a bug — sources are added and approved by a content manager before they become searchable.',
  },

  auth: {
    loginTitle: 'Sign in to BIS-Saathi',
    loginSubtitle: 'Your chats and saved standards are private to your account.',
    registerTitle: 'Create your account',
    registerSubtitle: 'Needed to save conversations and product profiles.',
    emailLabel: 'Email',
    emailPlaceholder: 'you@example.com',
    passwordLabel: 'Password',
    passwordPlaceholder: 'At least 10 characters',
    fullNameLabel: 'Full name',
    fullNamePlaceholder: 'Your name',
    personaLabel: 'I am a…',
    personaPlaceholder: 'Choose one (optional)',
    submitLogin: 'Sign in',
    submitRegister: 'Create account',
    submitting: 'Working…',
    noAccount: 'No account yet?',
    haveAccount: 'Already have an account?',
    registerLink: 'Create one',
    loginLink: 'Sign in instead',
    forgotPassword: 'Forgot password?',
    forgotTitle: 'Reset your password',
    forgotBody:
      'Enter the email on your account. If an account exists, a reset link will be sent. We always show the same message either way, so this form cannot be used to find out who has an account.',
    forgotSubmit: 'Send reset link',
    forgotSentTitle: 'Check your email',
    forgotSentBody: 'If an account exists for that address, a reset link is on its way. Links expire after 30 minutes.',
    resetTitle: 'Choose a new password',
    resetSubmit: 'Set new password',
    resetDone: 'Your password has been changed. Please sign in again.',
    confirmPasswordLabel: 'Confirm password',
    passwordHint: 'At least 10 characters, including a letter and a number.',
    lockoutNotice: 'Too many failed attempts. Sign-in is temporarily locked.',
    demoNoticeTitle: 'Development accounts',
    demoNoticeBody:
      'This deployment is running against the local mock API. Credentials for the demo accounts are printed in the mock API server console at startup; they are generated per boot and are never stored in the repository.',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    errors: {
      invalidCredentials: 'Incorrect email or password.',
      accountLocked: 'Too many failed sign-in attempts. Try again later.',
      rateLimited: 'Too many requests. Please wait a moment and try again.',
      conflict: 'An account with this email already exists.',
      csrf: 'Your session expired. Please sign in again.',
      network: 'Cannot reach the server. Check your connection and try again.',
      validation: 'Please check the highlighted fields.',
      unknown: 'Something went wrong. Please try again.',
      passwordMismatch: 'The two passwords do not match.',
      weakPassword: 'Password is too weak.',
      sessionExpired: 'Your session expired. Please sign in again.',
    },
    personas: {
      CONSUMER: 'Consumer',
      MSME_MANUFACTURER: 'MSME / manufacturer',
      JEWELLER_RETAILER: 'Jeweller / retailer',
      STUDENT_ENGINEER: 'Student / engineer',
    },
  },

  chat: {
    title: 'Assistant',
    emptyTitle: 'Ask a question about Indian Standards',
    emptyBody:
      'Describe your product or ask about a BIS service. If key details are missing you will be asked up to three focused questions before an answer.',
    composerLabel: 'Your question',
    composerPlaceholder: 'Describe your product or ask about certification, hallmarking, standards…',
    send: 'Send',
    stop: 'Stop',
    retry: 'Retry',
    copy: 'Copy answer',
    copied: 'Copied',
    rename: 'Rename',
    renamePrompt: 'New title for this chat',
    delete: 'Delete',
    deleteConfirmTitle: 'Delete this conversation?',
    deleteConfirmBody: 'This removes the conversation and its messages for your account. This cannot be undone.',
    deleteConfirmAction: 'Delete conversation',
    messageCount: '{{count}} messages',
    followUpsTitle: 'You could also ask',
    thinking: 'Looking through approved sources…',
    streaming: 'Answering…',
    sourcesTitle: 'Sources',
    noConversationSelected: 'Select or start a conversation',
    conversationListEmpty: 'No conversations yet',
    conversationListEmptyBody: 'Questions you ask will appear here so you can return to them.',
    tierLabel: 'Evidence',
    tierStrong: 'Strong — at least two approved sources, all citations validated',
    tierPartial: 'Partial — some supporting evidence, or citations incomplete',
    tierNone: 'None — no approved evidence supports this answer',
    mockBadge: 'Mock provider',
    mockBadgeTitle: 'No real language model is configured',
    mockBadgeBody:
      'This deployment runs with LLM_PROVIDER=mock. Retrieval, citation validation and the fallback reply all work, but no grounded answer can be generated. Configure a provider or run the Spring Boot backend for real answers.',
    providerErrorTitle: 'Answer generation is unavailable',
    piiWarning: 'For your safety, please do not share personal identifiers in the chat.',
    informational: 'Informational — verify against current official sources',
    usageTitle: 'Request accounting',
    untitledConversation: 'New conversation',
    errorTitle: 'The answer did not complete',
    errorBody: 'Nothing has been saved as an answer. You can retry the same question.',
  },

  citations: {
    title: 'Evidence',
    railLabel: 'Evidence rail',
    emptyTitle: 'No sources for this answer',
    emptyBody:
      'This answer was produced without retrieved evidence — either because the knowledge base has nothing approved on the topic, or because the question did not need a source.',
    standardNo: 'Standard',
    section: 'Section / clause',
    docType: 'Document type',
    language: 'Language',
    lastVerified: 'Last verified',
    notVerified: 'Not verified',
    viewSource: 'Open source',
    snippet: 'Evidence snippet',
    expand: 'Show source detail',
    collapse: 'Hide source detail',
    refLabel: 'Citation reference',
    count: '{{count}} sources',
    oneSource: '1 source',
    noLink: 'No link recorded for this source',
  },

  states: {
    loading: 'Loading…',
    errorTitle: 'Something went wrong',
    errorBody: 'We could not load this. Nothing has been changed.',
    emptyGeneric: 'Nothing here yet',
    notFoundTitle: 'Page not found',
    notFoundBody: 'The page you asked for does not exist or has moved.',
    notFoundAction: 'Back to the start',
    forbiddenTitle: 'You do not have access',
    forbiddenBody: 'This area requires a role your account does not have.',
    offline: 'You appear to be offline.',
  },

  footer: {
    builtNote: 'Answers come only from an approved knowledge base of official material.',
    notAffiliated:
      'BIS-Saathi is an information tool. It is not a certification body and cannot issue, approve or validate any licence, certificate or hallmark.',
    apiDocs: 'API contract',
    sourceCode: 'Source',
  },

  dashboard: {
    greeting: 'Welcome, {{name}}',
    subtitle: 'Your questions, your account, and what this tool can and cannot do.',
    recentActivity: 'Recent conversations',
    recentActivityBody: 'Only your own conversations are listed — the server scopes every query to your account.',
    usage: 'Your usage',
    usageBody: 'Counts for this account only.',
    totalConversations: 'Conversations',
    totalMessages: 'Messages',
    shownHere: 'Shown above',
    emailVerified: 'Email verified',
    emailUnverified: 'Email not verified',
    account: 'Account',
    roles: 'Roles',
    memberSince: 'Member since',
    lastLogin: 'Last sign-in',
    privacy: 'Your data',
    privacyBody:
      'Conversations and messages are stored against your account and are never shared with other users. Restricted standards are held as metadata only and their text is never reproduced.',
  },

  admin: {
    subtitle: 'Ingestion and access control. Every action here is written to the audit log.',
    knowledgeStats: 'Knowledge base',
    knowledgeStatsBody: 'Only documents with status APPROVED that are not superseded can be retrieved.',
    documents: 'Documents',
    approvedDocuments: 'Approved documents',
    chunks: 'Chunks',
    approvedChunks: 'Retrievable chunks',
    byStatus: 'By status',
    ingestionJobs: 'Ingestion jobs',
    kbVersion: 'KB version',
    coverageDerivedFrom: 'Coverage derived from',
    ingestionJobsTitle: 'Ingestion jobs',
    ingestionJobsBody: 'Document ingestion runs, newest first. Failures are shown, never hidden.',
    noJobs: 'No ingestion jobs yet',
    noJobsBody: 'Documents enter the knowledge base through the P0 manifest pipeline.',
    failedJobs: '{{count}} ingestion job(s) failed',
    colTarget: 'Target',
    auditLogs: 'Audit log',
    auditLogsBody: 'Security-relevant events, newest first.',
    auditLogsRestricted: 'Audit logs are restricted to the ADMIN role.',
    noLogs: 'No audit events recorded yet',
    colWhen: 'When',
    colActor: 'Actor',
    colAction: 'Action',
    colOutcome: 'Outcome',
    colTrace: 'Trace ref',
  },
} as const;

/**
 * Widens the literal types produced by `as const` while preserving structure,
 * including array lengths. `hi.ts` is typed as `TranslationShape`, so a missing
 * key, an extra key, or a differently-sized list is a COMPILE error — an
 * untranslated string can never silently reach a Hindi-speaking user.
 */
type DeepWiden<T> = T extends readonly unknown[]
  ? { [K in keyof T]: DeepWiden<T[K]> }
  : T extends object
    ? { [K in keyof T]: DeepWiden<T[K]> }
    : T extends string
      ? string
      : T extends number
        ? number
        : T extends boolean
          ? boolean
          : T;

export type Translation = typeof en;
export type TranslationShape = DeepWiden<Translation>;
