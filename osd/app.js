'use strict';

const API = '/api/osd';
const TYPES = [
  ['OFFICIAL DIRECTIVE', 'Directive', 'Formal instructions issued by sector command.'],
  ['COMMAND ORDER', 'Command Order', 'A controlled order with recipients and effective dates.'],
  ['SECTOR NOTICE', 'Sector Notice', 'A concise notice for an authorized sector audience.'],
  ['ADMINISTRATIVE DOCUMENT', 'Administrative', 'Administrative decisions, records and requests.'],
  ['OPERATIONAL REPORT', 'Operational Report', 'An official report with findings and references.'],
  ['AUTHORIZATION DOCUMENT', 'Authorization', 'A recorded authorization with scope and expiry.'],
  ['OFFICIAL MEMORANDUM', 'Memorandum', 'An internal memorandum between authorized offices.'],
  ['SECURITY NOTICE', 'Security Notice', 'A security instruction or controlled notification.'],
  ['CLASSIFIED REPORT', 'Classified Report', 'A report for audiences with the required clearance.'],
  ['SECTOR BRIEFING', 'Sector Briefing', 'A structured briefing prepared for sector leadership.'],
  ['OPERATION ORDER', 'Operation Order', 'A controlled operational order for authorized recipients.'],
  ['INTELLIGENCE REPORT', 'Intelligence Report', 'A structured intelligence report with a classification.'],
  ['ADMINISTRATIVE ORDER', 'Administrative Order', 'An official administrative instruction.'],
  ['OFFICIAL LETTER', 'Official Letter', 'Formal correspondence issued by the document authority.']
];
const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET'];
const STATUSES = ['DRAFT', 'PENDING APPROVAL', 'APPROVED', 'ISSUED', 'REVOKED', 'EXPIRED', 'ARCHIVED'];
const ROLE_PERMISSIONS = {
  AGENT: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS'],
  SENIOR: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'APPROVE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS', 'VIEW_AUDIT_TRAIL', 'VIEW_SIGNER_ROLE'],
  COMMANDER: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'APPROVE_DOCUMENTS', 'SIGN_DOCUMENTS', 'ISSUE_DOCUMENTS', 'REVOKE_DOCUMENTS', 'ARCHIVE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS', 'VIEW_AUDIT_TRAIL', 'MANAGE_USERS', 'VIEW_SIGNER_ROLE', 'VIEW_SIGNER_IDENTITY'],
  ADMIN: ['VIEW_DOCUMENTS', 'CREATE_DOCUMENTS', 'EDIT_DRAFTS', 'SUBMIT_FOR_APPROVAL', 'APPROVE_DOCUMENTS', 'SIGN_DOCUMENTS', 'ISSUE_DOCUMENTS', 'REVOKE_DOCUMENTS', 'ARCHIVE_DOCUMENTS', 'DOWNLOAD_DOCUMENTS', 'SHARE_DOCUMENTS', 'VIEW_AUDIT_TRAIL', 'MANAGE_USERS', 'VIEW_SIGNER_ROLE', 'VIEW_SIGNER_IDENTITY']
};

const COPY = {
  ar: {
    topSystem: 'نظام إدارة الوثائق الرسمية', online: 'متصل', workspace: 'مساحة العمل', center: 'مركز الوثائق', create: 'إنشاء وثيقة',
    archive: 'أرشيف الوثائق', pending: 'بانتظار المراجعة', issued: 'الوثائق الصادرة', templates: 'قوالب الوثائق',
    verify: 'التحقق من وثيقة', audit: 'سجل التدقيق', settings: 'إعدادات النظام', systemStatus: 'حالة النظام',
    secureConnection: 'اتصال آمن', createDocument: 'إنشاء وثيقة', totalDocs: 'إجمالي الوثائق', accessibleRecords: 'سجلات متاحة حسب صلاحيتك',
    pendingApprovals: 'بانتظار الاعتماد', reviewQueue: 'في قائمة المراجعة', issuedDocs: 'وثائق صادرة', recordedOnSystem: 'مسجلة في النظام',
    drafts: 'مسودات', inProgress: 'قيد الإعداد', recentActivity: 'أحدث الوثائق', viewArchive: 'عرض الأرشيف', document: 'الوثيقة',
    typeCol: 'النوع', classificationCol: 'التصنيف', statusCol: 'الحالة', updatedCol: 'آخر تحديث', noDocs: 'لا توجد وثائق بعد',
    createFirst: 'أنشئ أول وثيقة رسمية لبدء السجل.', startDocument: 'ابدأ وثيقة جديدة', quickActions: 'إجراءات سريعة',
    newDocument: 'إنشاء وثيقة رسمية', newDocumentHint: 'ابدأ من قالب معتمد', reviewQueueAction: 'مراجعة واعتماد',
    reviewHint: 'وثائق تنتظر الإجراء', verifyDocument: 'التحقق من وثيقة', verifyHint: 'تحقق من الرقم أو رمز التحقق',
    integrityNote: 'تُسجّل النسخ الصادرة وسجل التدقيق على الخادم. لا تُعد هيئة الوثيقة وحدها دليلاً على أصالتها.',
    workflow: 'مسار الوثيقة', workflowCaption: 'كل انتقال حالة مسجل باسم المستخدم ووقته', stepDraft: 'إنشاء مسودة',
    stepReview: 'مراجعة واعتماد', stepSign: 'توقيع وإصدار', stepVerify: 'تحقق وأرشفة', creatorTitle: 'إنشاء وثيقة رسمية',
    documentDetails: 'بيانات الوثيقة', details: 'البيانات', preview: 'المعاينة', review: 'المراجعة', documentType: 'نوع الوثيقة',
    typeHint: 'اختر القالب المناسب لمحتوى الوثيقة.', title: 'العنوان', titleHint: 'سيظهر العنوان كما هو في النسخة الصادرة.',
    sector: 'القطاع', classification: 'درجة السرية', recipient: 'المستلم / الجهة', body: 'محتوى الوثيقة',
    bodyHint: 'يدعم المحرر النصوص والفقرات والمراجع. لا تُدخل بيانات حساسة لا حاجة لها.', notes: 'ملاحظات داخلية',
    expiry: 'تاريخ انتهاء اختياري', references: 'المراجع', timestampHint: 'يُنشئ الخادم رقم الوثيقة والطابع الزمني عند الحفظ أو الإصدار. لا يستطيع النموذج تغيير وقت الإصدار.',
    cancel: 'إلغاء', previewDocument: 'معاينة الوثيقة', saveDraft: 'حفظ كمسودة', previewPane: 'معاينة الوثيقة', live: 'مباشر',
    previewNotIssued: 'معاينة فقط — لا تُعد وثيقة صادرة أو موقعة.', templateTip: 'التنسيق جاهز',
    templateTipSub: 'سيُطبّق القالب والترويسة والترقيم تلقائياً عند الإصدار.', archiveTitle: 'أرشيف الوثائق',
    searchDocuments: 'ابحث بالرقم أو العنوان أو رمز التحقق', allTypes: 'جميع الأنواع', allStatuses: 'جميع الحالات',
    allClassifications: 'جميع التصنيفات', reset: 'مسح التصفية', sectorCol: 'القطاع', noMatches: 'لا توجد وثائق مطابقة',
    tryFilters: 'عدّل البحث أو المرشحات، أو أنشئ وثيقة جديدة.', pendingTitle: 'بانتظار المراجعة والاعتماد',
    nothingPending: 'لا توجد وثائق تنتظر الإجراء', pendingHint: 'ستظهر هنا الوثائق المرسلة للاعتماد.',
    issuedTitle: 'الوثائق الصادرة', issuedAt: 'تاريخ الإصدار', noIssued: 'لا توجد وثائق صادرة',
    issuedHint: 'الوثائق المعتمدة والموقعة ستظهر هنا.', draftsTitle: 'مسودات الوثائق', noDrafts: 'لا توجد مسودات',
    draftsHint: 'ستظهر هنا الوثائق التي لم تُرسل بعد للمراجعة.', templateTitle: 'قوالب رسمية جاهزة',
    templateCaption: 'اختر نوع الوثيقة؛ يتولى النظام التنسيق والترقيم والتصنيف.',
    verifyTitle: 'التحقق من وثيقة رسمية', verifyCaption: 'أدخل رقم الوثيقة أو رمز التحقق لفحص سجل الإصدار وسلامة التوقيع.',
    verifyNow: 'تحقق الآن', integrity: 'سلامة الوثيقة',
    integrityCaption: 'يطابق التحقق سجل الخادم وبصمة النسخة الصادرة. لا يضمن وحده صلاحية المحتوى أو هوية حامله.',
    verifyStates: 'حالات التحقق', validHint: 'سجل الإصدار والبصمة متطابقان', revokedHint: 'تم إلغاء الوثيقة في النظام',
    expiredHint: 'انتهت فترة صلاحية الوثيقة', missingHint: 'لا يوجد سجل مطابق',
    verificationPrivacy: 'لا تعرض صفحة التحقق العامة المحتوى أو الاسم الحقيقي للموقّع.', auditTitle: 'سجل التدقيق',
    noAudit: 'لا توجد أحداث متاحة', auditHint: 'يتطلب عرض هذا السجل صلاحية تدقيق مناسبة.',
    usersTitle: 'مستخدمو النظام والصلاحيات', addUser: 'إضافة مستخدم',
    usersCopy: 'صلاحيات API مفروضة على الخادم. إخفاء عناصر الواجهة ليس بديلاً عن التفويض.',
    privacyTitle: 'خصوصية هوية الموقّع', privacyCopy: 'تُخزن هوية الموقّع في سجل الإصدار، لكن الاستجابات تخفي الاسم الحقيقي ما لم يملك المستخدم صلاحية VIEW_SIGNER_IDENTITY.',
    signatureModel: 'نموذج التوقيع', recordModel: 'سجل النسخ', auditModel: 'سجل التدقيق',
    signatureDialogTitle: 'التوقيع الرسمي بخط اليد', signatureDialogHint: 'ارسم توقيعك بنفسك بإصبعك أو القلم أو الفأرة. سيُضمّن الرسم في النسخة الصادرة ويُربط ببصمتها.',
    signatureClear: 'مسح التوقيع', signatureCancel: 'إلغاء', signatureConfirm: 'توقيع وإصدار الوثيقة',
    signatureEmpty: 'ارسم توقيعك داخل الإطار قبل الإصدار.', signaturePending: 'التوقيع مطلوب عند الإصدار',
    issuedUtc: 'تاريخ ووقت الإصدار · UTC', documentIdLabel: 'معرّف الوثيقة', authorizationLevelLabel: 'مستوى التصريح',
    signerSignatureAlt: 'التوقيع اليدوي للمُصدر', signatureRecorded: 'توقيع يدوي مسجل في وقت الإصدار',
    footerNote: 'وثائق مستقلة · تحقق من الصلاحية قبل المشاركة', signIn: 'تسجيل الدخول', firstSetup: 'الإعداد الأولي',
    authSubtitle: 'نظام الوثائق الرسمية للقطاعات', username: 'اسم المستخدم', password: 'كلمة المرور',
    firstSetupRequired: 'إنشاء قائد النظام الأول', setupHint: 'يتطلب OSD_BOOTSTRAP_CODE مضبوطاً على الخادم. لا ترسل الرمز في المحادثة.',
    bootstrapCode: 'رمز الإعداد الخادمي', displayName: 'الاسم المعروض', createCommander: 'إنشاء حساب القائد',
    authSecure: 'جلسات آمنة · صلاحيات خادمية · لا توجد بيانات دخول تجريبية',
    required: 'يرجى استكمال الحقول المطلوبة.', saved: 'حُفظت المسودة.', submitted: 'أُرسلت الوثيقة للمراجعة.',
    approved: 'تم اعتماد الوثيقة.', issuedMessage: 'تم توقيع الوثيقة وإصدارها.', revokedMessage: 'أُلغيت الوثيقة.',
    archivedMessage: 'أُرشفت الوثيقة.', noPermission: 'ليس لديك صلاحية لهذا الإجراء.',
    createFailed: 'تعذر حفظ الوثيقة.', noRecords: 'لا توجد سجلات متاحة.', print: 'طباعة / حفظ PDF',
    editDraft: 'تعديل المسودة', amendDocument: 'إنشاء إصدار جديد', sendReview: 'إرسال للاعتماد', approve: 'اعتماد', signIssue: 'توقيع وإصدار',
    revoke: 'إلغاء الوثيقة', archiveAction: 'أرشفة', share: 'إنشاء رابط آمن', auditAction: 'سجل التدقيق',
    versions: 'سجل الإصدارات', close: 'إغلاق', verificationCode: 'رمز التحقق', issuedLabel: 'تاريخ الإصدار',
    expires: 'ينتهي في', recipientLabel: 'المستلم', signer: 'الموقّع', versionLabel: 'الإصدار',
    confirmIssue: 'سيُسجل توقيعك باسم حسابك الحالي ويصدر إصداراً غير قابل للتحرير. هل تريد المتابعة؟',
    confirmApprove: 'اعتماد هذه الوثيقة وإرسالها للتوقيع؟', confirmRevoke: 'سبب إلغاء الوثيقة؟',
    copied: 'نُسخ الرابط الآمن.', shareCreated: 'تم إنشاء رابط آمن.', addUserTitle: 'حساب مستخدم جديد',
    createUser: 'إنشاء المستخدم', enabled: 'مفعل', disabled: 'موقوف', save: 'حفظ', role: 'الدور',
    clearanceLabel: 'التصريح', noUsers: 'لا يوجد مستخدمون متاحون.', verifyValid: 'DOCUMENT VALID',
    verifyRevoked: 'DOCUMENT REVOKED', verifyExpired: 'DOCUMENT EXPIRED', verifyNotFound: 'DOCUMENT NOT FOUND',
    verifyFailed: 'DOCUMENT INTEGRITY CHECK FAILED', verifyUnknown: 'DOCUMENT NOT VERIFIED',
    verificationNumber: 'رقم الوثيقة', printNote: 'استخدم خيار Save as PDF في نافذة الطباعة.',
    titleRequired: 'العنوان مطلوب.', bodyRequired: 'المحتوى مطلوب.', bootstrapCreated: 'تم إنشاء حساب القائد. سجّل الدخول.', created: 'تم إنشاء المستخدم.',
    loginFailed: 'تعذر تسجيل الدخول.', setupUnavailable: 'الإعداد الأولي غير متاح. تحقّق من إعداد الخادم.',
    expiryInvalid: 'تاريخ الانتهاء غير صالح.', showIdentity: 'اسم الموقّع ظاهر وفق صلاحيتك.',
    publicSigner: 'AUTHORIZED COMMAND', fileNo: 'رقم الوثيقة', more: 'المزيد',
    centerEyebrow: 'OFFICIAL DOCUMENTS CENTER', pendingEyebrow: 'COMMAND REVIEW QUEUE',
    issuedEyebrow: 'SIGNED REGISTER', archiveEyebrow: 'DOCUMENT REGISTER',
    verifyEyebrow: 'OSD AUTHENTICITY SERVICE', auditEyebrow: 'APPEND-ONLY EVENT REGISTER',
    createEyebrow: 'NEW OFFICIAL RECORD', templatesEyebrow: 'CONTROLLED FORMAT LIBRARY',
    settingsEyebrow: 'IDENTITY & ACCESS', previewDraft: 'معاينة الوثيقة'
  },
  en: {
    topSystem: 'DOCUMENT AUTHORITY SYSTEM', online: 'ONLINE', workspace: 'WORKSPACE', center: 'Document Center',
    create: 'Create Document', archive: 'Document Archive', pending: 'Pending Approval', issued: 'Issued Documents',
    templates: 'Document Templates', verify: 'Verify a Document', audit: 'Audit Trail', settings: 'System Settings',
    systemStatus: 'SYSTEM STATUS', secureConnection: 'SECURE CONNECTION', createDocument: 'Create Document',
    totalDocs: 'Total Documents', accessibleRecords: 'Records available at your clearance', pendingApprovals: 'Pending Approval',
    reviewQueue: 'In the review queue', issuedDocs: 'Issued Documents', recordedOnSystem: 'Recorded in the system',
    drafts: 'Drafts', inProgress: 'In progress', recentActivity: 'Recent Documents', viewArchive: 'View archive',
    document: 'DOCUMENT', typeCol: 'TYPE', classificationCol: 'CLASSIFICATION', statusCol: 'STATUS', updatedCol: 'UPDATED',
    noDocs: 'No documents yet', createFirst: 'Create the first official document to start the register.',
    startDocument: 'Start a document', quickActions: 'Quick Actions', newDocument: 'Create Official Document',
    newDocumentHint: 'Start with a controlled template', reviewQueueAction: 'Review & Approve',
    reviewHint: 'Documents awaiting action', verifyDocument: 'Verify Document', verifyHint: 'Check a number or code',
    integrityNote: 'Issued versions and audit events are recorded server-side. Document appearance alone does not prove authenticity.',
    workflow: 'Document Workflow', workflowCaption: 'Every state transition records the user and timestamp',
    stepDraft: 'Create Draft', stepReview: 'Review & Approve', stepSign: 'Sign & Issue', stepVerify: 'Verify & Archive',
    creatorTitle: 'Create Official Document', documentDetails: 'Document Details', details: 'Details',
    preview: 'Preview', review: 'Review', documentType: 'Document Type', typeHint: 'Choose the template for this document.',
    title: 'Title', titleHint: 'The title appears as entered on the issued version.', sector: 'Sector',
    classification: 'Classification', recipient: 'Recipient / Office', body: 'Document Content',
    bodyHint: 'Plain text, paragraphs and references are supported. Avoid unnecessary sensitive details.',
    notes: 'Internal Notes', expiry: 'Optional Expiry Date', references: 'References',
    timestampHint: 'The server creates the document number and timestamps. A form cannot set the issue time.',
    cancel: 'Cancel', previewDocument: 'Preview Document', saveDraft: 'Save Draft', previewPane: 'Document Preview',
    live: 'LIVE', previewNotIssued: 'Preview only — this is not an issued or signed document.',
    templateTip: 'Format is ready', templateTipSub: 'The template, header and numbering are applied automatically on issue.',
    archiveTitle: 'Document Archive', searchDocuments: 'Search number, title or verification code',
    allTypes: 'All Types', allStatuses: 'All Statuses', allClassifications: 'All Classifications', reset: 'Reset',
    sectorCol: 'SECTOR', noMatches: 'No matching documents', tryFilters: 'Adjust filters or create a new document.',
    pendingTitle: 'Pending Review & Approval', nothingPending: 'Nothing is waiting for action',
    pendingHint: 'Documents submitted for approval appear here.', issuedTitle: 'Issued Documents',
    issuedAt: 'ISSUED AT', noIssued: 'No issued documents', issuedHint: 'Approved and signed documents appear here.',
    draftsTitle: 'Document Drafts', noDrafts: 'No drafts yet', draftsHint: 'Documents not yet submitted for approval appear here.',
    templateTitle: 'Official Templates', templateCaption: 'Choose a document type; formatting, numbering and classification are handled for you.',
    verifyTitle: 'Verify an Official Document', verifyCaption: 'Enter a document number or verification code to check the issue record and signature integrity.',
    verifyNow: 'Verify Now', integrity: 'Document Integrity',
    integrityCaption: 'Verification checks the server record and issued-version signature. It does not establish content suitability or holder identity.',
    verifyStates: 'Verification States', validHint: 'Issue record and signature match', revokedHint: 'The document was revoked',
    expiredHint: 'The document has expired', missingHint: 'No matching record exists',
    verificationPrivacy: 'The public verification page does not expose content or the signer’s real name.',
    auditTitle: 'Audit Trail', noAudit: 'No events available', auditHint: 'Viewing this register requires audit permission.',
    usersTitle: 'System Users & Permissions', addUser: 'Add User',
    usersCopy: 'API permissions are enforced server-side. Hiding UI controls is not authorization.',
    privacyTitle: 'Signer Identity Privacy',
    privacyCopy: 'Signer identity is kept in the issue record, but responses conceal the real name unless the viewer has VIEW_SIGNER_IDENTITY.',
    signatureModel: 'Signature Model', recordModel: 'Version Record', auditModel: 'Audit Record',
    signatureDialogTitle: 'Handwritten Official Signature', signatureDialogHint: 'Draw your own signature with a finger, stylus, or mouse. The drawing is embedded in the issued version and included in its integrity signature.',
    signatureClear: 'Clear Signature', signatureCancel: 'Cancel', signatureConfirm: 'Sign & Issue Document',
    signatureEmpty: 'Draw your signature in the box before issuing.', signaturePending: 'Signature required at issue',
    issuedUtc: 'ISSUED AT · UTC', documentIdLabel: 'DOCUMENT ID', authorizationLevelLabel: 'AUTHORIZATION LEVEL',
    signerSignatureAlt: 'Issuer handwritten signature', signatureRecorded: 'Handwritten signature recorded at issue',
    footerNote: 'Independent records · Verify access before sharing', signIn: 'Sign In', firstSetup: 'Initial Setup',
    authSubtitle: 'Official Sector Documents System', username: 'Username', password: 'Password',
    firstSetupRequired: 'Create the first system commander',
    setupHint: 'OSD_BOOTSTRAP_CODE must be configured on the server. Never send the code in chat.',
    bootstrapCode: 'Server Setup Code', displayName: 'Display Name', createCommander: 'Create Commander Account',
    authSecure: 'Secure sessions · server-side authorization · no demo credentials',
    required: 'Complete the required fields.', saved: 'Draft saved.', submitted: 'Document submitted for review.',
    approved: 'Document approved.', issuedMessage: 'Document signed and issued.', revokedMessage: 'Document revoked.',
    archivedMessage: 'Document archived.', noPermission: 'You are not authorized for this action.',
    createFailed: 'Could not save the document.', noRecords: 'No records available.', print: 'Print / Save PDF',
    editDraft: 'Edit Draft', amendDocument: 'Create Amendment', sendReview: 'Submit for Approval', approve: 'Approve', signIssue: 'Sign & Issue',
    revoke: 'Revoke', archiveAction: 'Archive', share: 'Create Secure Link', auditAction: 'Audit Trail',
    versions: 'Version History', close: 'Close', verificationCode: 'Verification Code', issuedLabel: 'Issued At',
    expires: 'Expires', recipientLabel: 'Recipient', signer: 'Signer', versionLabel: 'Version',
    confirmIssue: 'This records your account as signer and issues a non-editable version. Continue?',
    confirmApprove: 'Approve this document and move it to signing?', confirmRevoke: 'Reason for revocation?',
    copied: 'Secure link copied.', shareCreated: 'Secure link created.', addUserTitle: 'New User Account',
    createUser: 'Create User', enabled: 'Enabled', disabled: 'Disabled', save: 'Save', role: 'Role',
    clearanceLabel: 'Clearance', noUsers: 'No users available.', verifyValid: 'DOCUMENT VALID',
    verifyRevoked: 'DOCUMENT REVOKED', verifyExpired: 'DOCUMENT EXPIRED', verifyNotFound: 'DOCUMENT NOT FOUND',
    verifyFailed: 'DOCUMENT INTEGRITY CHECK FAILED', verifyUnknown: 'DOCUMENT NOT VERIFIED',
    verificationNumber: 'Document Number', printNote: 'Choose Save as PDF in the print dialog.',
    titleRequired: 'A title is required.', bodyRequired: 'Document content is required.', created: 'User created.',
    bootstrapCreated: 'Commander account created. Sign in.', loginFailed: 'Sign-in failed.',
    setupUnavailable: 'Initial setup is unavailable. Check server configuration.', expiryInvalid: 'Invalid expiry date.',
    showIdentity: 'Signer identity is visible at your permission level.', publicSigner: 'AUTHORIZED COMMAND',
    fileNo: 'DOCUMENT NO.', more: 'More', centerEyebrow: 'OFFICIAL DOCUMENTS CENTER',
    pendingEyebrow: 'COMMAND REVIEW QUEUE', issuedEyebrow: 'SIGNED REGISTER', archiveEyebrow: 'DOCUMENT REGISTER',
    verifyEyebrow: 'OSD AUTHENTICITY SERVICE', auditEyebrow: 'APPEND-ONLY EVENT REGISTER',
    createEyebrow: 'NEW OFFICIAL RECORD', templatesEyebrow: 'CONTROLLED FORMAT LIBRARY',
    settingsEyebrow: 'IDENTITY & ACCESS', previewDraft: 'Preview Document'
  }
};

const PAGE_TEXT = {
  center: ['centerEyebrow', 'مركز الوثائق الرسمية', 'إدارة الوثائق الرسمية المصرح لك بالوصول إليها.'],
  create: ['createEyebrow', 'إنشاء وثيقة رسمية', 'أدخل المعلومات الأساسية؛ يتولى النظام الترقيم والتنسيق.'],
  archive: ['archiveEyebrow', 'أرشيف الوثائق', 'ابحث في الوثائق المتاحة حسب صلاحيتك.'],
  drafts: ['archiveEyebrow', 'مسودات الوثائق', 'تابع الوثائق التي لم تُرسل بعد للمراجعة.'],
  pending: ['pendingEyebrow', 'بانتظار المراجعة والاعتماد', 'اعتمد الوثائق المرسلة أو أعدها لمسار المراجعة.'],
  issued: ['issuedEyebrow', 'الوثائق الصادرة', 'نسخ رسمية صدرت بتوقيع مسجل على الخادم.'],
  templates: ['templatesEyebrow', 'قوالب رسمية جاهزة', 'اختر نوع الوثيقة؛ يتولى النظام التنسيق والترقيم والتصنيف.'],
  verify: ['verifyEyebrow', 'التحقق من وثيقة رسمية', 'تحقق من سجل الإصدار وسلامة النسخة الأصلية.'],
  audit: ['auditEyebrow', 'سجل التدقيق', 'أحداث النظام مرتبة حسب وقت تسجيلها.'],
  settings: ['settingsEyebrow', 'إعدادات النظام', 'إدارة حسابات OSD والصلاحيات المستقلة.']
};

const state = {
  user: null,
  documents: [],
  page: 'center',
  language: 'ar',
  editingId: null,
  selectedDocument: null,
  bootstrapNeeded: false,
  shareDocument: null,
  publicMode: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const t = (key) => COPY[state.language]?.[key] || COPY.en[key] || key;
const can = (permission) => !!state.user && state.user.permissions.includes(permission);

async function request(path, options = {}) {
  const response = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('#toastRegion').append(node);
  window.setTimeout(() => node.remove(), 3800);
}

function setLanguage(language) {
  state.language = language;
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  document.body.dir = language === 'ar' ? 'rtl' : 'ltr';
  $$('.lang-toggle').forEach((button) => { button.textContent = language === 'ar' ? 'EN' : 'عربي'; });
  $$('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  renderPageHeading();
  renderRows();
  renderPreview();
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(state.language === 'ar' ? 'en-GB' : 'en-US', {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {})
  }).format(date);
}

function formatUtcTimestamp(value) {
  if (!value) return state.language === 'ar' ? 'يُنشأ عند الإصدار' : 'GENERATED ON ISSUE';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat(state.language === 'ar' ? 'en-GB' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'UTC'
  }).format(date).toUpperCase();
  return `${formatted} UTC`;
}

function updateClock() {
  const now = new Date();
  $('#clock').textContent = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  $('#today').textContent = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(now).toUpperCase();
}

function showAuth(show) {
  $('#authScreen').hidden = !show;
  if (show) $('#loginUsername').focus();
}

function setPage(page) {
  if (state.publicMode) return;
  state.page = page;
  $$('.page-view').forEach((element) => element.classList.toggle('active', element.id === `page-${page}`));
  $$('.nav-item[data-page]').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  renderPageHeading();
  if (page === 'create') renderPreview();
  if (page === 'settings') void loadUsers();
  if (page === 'audit') void loadAudit();
  if (page === 'templates') renderTemplates();
  if (page === 'archive') renderRows();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPageHeading() {
  const [eyebrowKey, arabicTitle, arabicCaption] = PAGE_TEXT[state.page] || PAGE_TEXT.center;
  const english = {
    center: ['Official Documents Center', 'Manage official documents available to your account.'],
    create: ['Create Official Document', 'Enter the essential details; OSD applies the official format.'],
    archive: ['Document Archive', 'Search records available at your clearance.'],
    drafts: ['Document Drafts', 'Manage documents that have not yet been submitted for approval.'],
    pending: ['Pending Review & Approval', 'Review documents submitted to the approval queue.'],
    issued: ['Issued Documents', 'Official versions signed and recorded on the server.'],
    templates: ['Official Templates', 'Choose a type; OSD handles formatting and numbering.'],
    verify: ['Verify an Official Document', 'Check the issue record and integrity of an issued version.'],
    audit: ['Audit Trail', 'System events ordered by their recorded time.'],
    settings: ['System Settings', 'Manage independent OSD accounts and permissions.']
  };
  $('#pageEyebrow').textContent = t(eyebrowKey);
  $('#pageTitle').textContent = state.language === 'ar' ? arabicTitle : english[state.page][0];
  $('#pageCaption').textContent = state.language === 'ar' ? arabicCaption : english[state.page][1];
}

function classificationTag(classification) {
  const slug = String(classification || '').toLowerCase().replace(/\s+/g, '-');
  return `<span class="classification-tag ${escapeHtml(slug)}">${escapeHtml(classification || '—')}</span>`;
}

function statusTag(status) {
  const slug = String(status || '').toLowerCase().replace(/\s+/g, '-');
  return `<span class="status-tag ${escapeHtml(slug)}">${escapeHtml(status || '—')}</span>`;
}

function docCell(document) {
  return `<div class="doc-cell"><strong>${escapeHtml(document.documentNumber)}</strong><small>${escapeHtml(document.title)}</small></div>`;
}

function actionCell(document) {
  return `<button class="row-action" data-action="viewDocument" data-id="${escapeHtml(document.id)}" aria-label="Open document" title="${escapeHtml(t('more'))}">···</button>`;
}

function filteredDocuments(status = '') {
  let documents = state.documents.slice();
  if (status) documents = documents.filter((doc) => doc.status === status);
  if (state.page === 'drafts') documents = documents.filter((doc) => doc.status === 'DRAFT');
  if (state.page === 'archive') {
    const search = $('#archiveSearch')?.value.trim().toLowerCase() || '';
    const type = $('#filterType')?.value || '';
    const docStatus = $('#filterStatus')?.value || '';
    const classification = $('#filterClass')?.value || '';
    if (type) documents = documents.filter((doc) => doc.type === type);
    if (docStatus) documents = documents.filter((doc) => doc.status === docStatus);
    if (classification) documents = documents.filter((doc) => doc.classification === classification);
    if (search) documents = documents.filter((doc) => [doc.documentNumber, doc.title, doc.verificationCode].some((value) => String(value).toLowerCase().includes(search)));
  }
  return documents;
}

function renderRows() {
  const docs = state.documents;
  const recent = docs.slice(0, 5);
  $('#recentRows').innerHTML = recent.map((doc) => `<tr><td>${docCell(doc)}</td><td>${escapeHtml(doc.type)}</td><td>${classificationTag(doc.classification)}</td><td>${statusTag(doc.status)}</td><td>${escapeHtml(formatDate(doc.updatedAt, true))}</td><td>${actionCell(doc)}</td></tr>`).join('');
  $('#recentEmpty').classList.toggle('visible', !recent.length);
  $('#statTotal').textContent = docs.length;
  $('#statPending').textContent = docs.filter((doc) => doc.status === 'PENDING APPROVAL').length;
  $('#statIssued').textContent = docs.filter((doc) => ['ISSUED', 'ARCHIVED'].includes(doc.status)).length;
  $('#statDrafts').textContent = docs.filter((doc) => doc.status === 'DRAFT').length;
  $('#pendingCount').textContent = docs.filter((doc) => doc.status === 'PENDING APPROVAL').length;

  const archive = filteredDocuments();
  $('#archiveRows').innerHTML = archive.map((doc) => `<tr><td>${docCell(doc)}</td><td>${escapeHtml(doc.type)}</td><td>${escapeHtml(doc.sector)}</td><td>${classificationTag(doc.classification)}</td><td>${statusTag(doc.status)}</td><td>${escapeHtml(formatDate(doc.updatedAt, true))}</td><td>${actionCell(doc)}</td></tr>`).join('');
  $('#archiveCount').textContent = `${archive.length} RECORD${archive.length === 1 ? '' : 'S'}`;
  $('#archiveEmpty').classList.toggle('visible', !archive.length);

  const pending = docs.filter((doc) => doc.status === 'PENDING APPROVAL');
  $('#pendingRows').innerHTML = pending.map((doc) => `<tr><td>${docCell(doc)}</td><td>${escapeHtml(doc.type)}</td><td>${escapeHtml(doc.sector)}</td><td>${classificationTag(doc.classification)}</td><td>${escapeHtml(formatDate(doc.updatedAt, true))}</td><td>${actionCell(doc)}</td></tr>`).join('');
  $('#pendingPanelCount').textContent = `${pending.length} PENDING`;
  $('#pendingEmpty').classList.toggle('visible', !pending.length);

  const issued = docs.filter((doc) => ['ISSUED', 'ARCHIVED'].includes(doc.status));
  $('#issuedRows').innerHTML = issued.map((doc) => `<tr><td>${docCell(doc)}</td><td>${escapeHtml(doc.type)}</td><td>${escapeHtml(doc.sector)}</td><td>${classificationTag(doc.classification)}</td><td>${escapeHtml(formatDate(doc.issuedAt, true))}</td><td>${actionCell(doc)}</td></tr>`).join('');
  $('#issuedCount').textContent = `${issued.length} ISSUED`;
  $('#issuedEmpty').classList.toggle('visible', !issued.length);

  const drafts = docs.filter((doc) => doc.status === 'DRAFT');
  $('#draftRows').innerHTML = drafts.map((doc) => `<tr><td>${docCell(doc)}</td><td>${escapeHtml(doc.type)}</td><td>${escapeHtml(doc.sector)}</td><td>${classificationTag(doc.classification)}</td><td>${escapeHtml(formatDate(doc.updatedAt, true))}</td><td>${actionCell(doc)}</td></tr>`).join('');
  $('#draftCount').textContent = `${drafts.length} DRAFT${drafts.length === 1 ? '' : 'S'}`;
  $('#draftEmpty').classList.toggle('visible', !drafts.length);
}

async function loadDocuments() {
  const result = await request('/documents');
  state.documents = result.documents || [];
  renderRows();
}

function initSelects() {
  $('#docType').innerHTML = TYPES.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(state.language === 'ar' ? value : value)}</option>`).join('');
  $('#docClassification').innerHTML = CLASSIFICATIONS.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  $('#filterType').insertAdjacentHTML('beforeend', TYPES.map(([value]) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
  $('#filterStatus').insertAdjacentHTML('beforeend', STATUSES.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
  $('#filterClass').insertAdjacentHTML('beforeend', CLASSIFICATIONS.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join(''));
  $('#docClassification').value = 'INTERNAL';
}

function documentPayload() {
  const expiry = $('#docExpiry').value;
  return {
    type: $('#docType').value,
    title: $('#docTitle').value.trim(),
    sector: $('#docSector').value.trim(),
    classification: $('#docClassification').value,
    recipient: $('#docRecipient').value.trim(),
    body: $('#docBody').value,
    notes: $('#docNotes').value.trim(),
    expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null,
    references: $('#docReferences').value.split(',').map((value) => value.trim()).filter(Boolean),
    changeNote: state.editingId ? 'Draft edited in OSD document editor' : ''
  };
}

function renderPreview(documentData = null) {
  const data = documentData || {
    type: $('#docType')?.value || TYPES[0][0],
    title: $('#docTitle')?.value.trim() || 'DOCUMENT TITLE',
    sector: $('#docSector')?.value.trim() || 'LOS SANTOS SECTOR',
    classification: $('#docClassification')?.value || 'INTERNAL',
    recipient: $('#docRecipient')?.value.trim() || '',
    body: $('#docBody')?.value || ''
  };
  $('#previewClassification').textContent = data.classification || 'INTERNAL';
  $('#paperFooterClassification').textContent = data.classification || 'INTERNAL';
  $('#previewType').textContent = data.type || TYPES[0][0];
  $('#previewTitle').textContent = data.title || 'DOCUMENT TITLE';
  $('#previewSector').textContent = String(data.sector || 'LOS SANTOS SECTOR').toUpperCase();
  $('#previewRecipient').textContent = data.recipient ? `TO: ${data.recipient}` : 'TO: AUTHORIZED RECIPIENT';
  $('#previewBody').textContent = data.body?.text || data.body || (state.language === 'ar' ? 'سيظهر محتوى الوثيقة هنا عند إكمال النموذج.' : 'Your document content will appear here as you complete the form.');
  $('#previewNumber').textContent = data.documentNumber || (state.language === 'ar' ? 'يُنشأ عند الإصدار' : 'GENERATED ON ISSUE');
  $('#previewDate').textContent = formatUtcTimestamp(data.issuedAt);
  $('#previewDocumentId').textContent = data.id || (state.language === 'ar' ? 'يُنشأ عند الحفظ' : 'GENERATED ON SAVE');
  $('#previewAuthorizationLevel').textContent = data.signature?.authorizationLevel || data.authorizationLevel || data.classification || '—';
  $('#previewVersion').textContent = data.version || 'DRAFT';
  $('#previewVerificationCode').textContent = data.verificationCode || (state.language === 'ar' ? 'يُنشأ عند الإصدار' : 'GENERATED ON ISSUE');
  $('#previewSigner').textContent = data.signature?.display || (data.signature ? t('publicSigner') : t('signaturePending'));
  $('#previewSignatureCaption').textContent = data.signature?.signatureImage ? t('signatureRecorded') : t('signaturePending');
  const signatureImage = data.signature?.signatureImage;
  const image = $('#previewSignature');
  if (typeof signatureImage === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signatureImage)) {
    image.src = signatureImage;
    image.hidden = false;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
  }
}

function renderTemplates() {
  $('#templateGrid').innerHTML = TYPES.map(([type, label, description], index) => `
    <button class="template-card" data-action="useTemplate" data-type="${escapeHtml(type)}">
      <span class="template-card-icon">${['↗','▤','◈','⌂','≋','◇','▧','⊙','▦','⌖'][index]}</span>
      <strong>${escapeHtml(type)}</strong><small>${escapeHtml(state.language === 'ar' ? `قالب ${label} — تنسيق رسمي جاهز` : description)}</small>
      <span class="template-arrow">↙</span>
    </button>`).join('');
}

function fieldMeta(label, value) {
  return `<div class="dialog-meta"><small>${escapeHtml(label)}</small><b>${escapeHtml(value || '—')}</b></div>`;
}

function modalActions(document) {
  const actions = [`<button class="button button-quiet" data-action="closeModal">${escapeHtml(t('close'))}</button>`];
  const activeIssued = ['ISSUED', 'ARCHIVED'].includes(document.status) && !document.revokedAt &&
    !(document.expiresAt && new Date(document.expiresAt).getTime() <= Date.now());
  if (document.status === 'DRAFT' && can('EDIT_DRAFTS')) {
    actions.push(`<button class="button button-outline" data-action="editDraft" data-id="${escapeHtml(document.id)}">${escapeHtml(t('editDraft'))}</button>`);
    if (can('SUBMIT_FOR_APPROVAL')) actions.push(`<button class="button button-primary" data-action="submitForApproval" data-id="${escapeHtml(document.id)}">${escapeHtml(t('sendReview'))}</button>`);
  }
  if (document.status === 'PENDING APPROVAL' && can('APPROVE_DOCUMENTS')) actions.push(`<button class="button button-primary" data-action="approveDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('approve'))}</button>`);
  if (document.status === 'APPROVED' && can('ISSUE_DOCUMENTS') && can('SIGN_DOCUMENTS')) actions.push(`<button class="button button-primary" data-action="issueDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('signIssue'))}</button>`);
  if (activeIssued && can('CREATE_DOCUMENTS')) actions.push(`<button class="button button-outline" data-action="amendDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('amendDocument'))}</button>`);
  if (activeIssued && can('DOWNLOAD_DOCUMENTS')) actions.push(`<button class="button button-outline" data-action="printDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('print'))}</button>`);
  if (activeIssued && can('SHARE_DOCUMENTS')) actions.push(`<button class="button button-outline" data-action="shareDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('share'))}</button>`);
  if (document.status === 'ISSUED' && can('REVOKE_DOCUMENTS')) actions.push(`<button class="button button-quiet" data-action="revokeDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('revoke'))}</button>`);
  if (['ISSUED', 'REVOKED', 'EXPIRED'].includes(document.status) && can('ARCHIVE_DOCUMENTS')) actions.push(`<button class="button button-quiet" data-action="archiveDocument" data-id="${escapeHtml(document.id)}">${escapeHtml(t('archiveAction'))}</button>`);
  if (can('VIEW_AUDIT_TRAIL')) actions.push(`<button class="button button-quiet" data-action="showAudit" data-id="${escapeHtml(document.id)}">${escapeHtml(t('auditAction'))}</button>`);
  if (can('VIEW_DOCUMENTS')) actions.push(`<button class="button button-quiet" data-action="showVersions" data-id="${escapeHtml(document.id)}">${escapeHtml(t('versions'))}</button>`);
  return actions.join('');
}

function showDocument(document) {
  state.selectedDocument = document;
  $('#modalTitle').textContent = document.title;
  $('#modalNumber').textContent = document.documentNumber;
  const body = document.body?.text || '';
  const signer = document.signature?.display || t('publicSigner');
  $('#modalContent').innerHTML = `
    <div class="dialog-meta-grid">
      ${fieldMeta(t('fileNo'), document.documentNumber)}
      ${fieldMeta(t('statusCol'), document.status)}
      ${fieldMeta(t('typeCol'), document.type)}
      ${fieldMeta(t('classificationCol'), document.classification)}
      ${fieldMeta(t('sectorCol'), document.sector)}
      ${fieldMeta(t('versionLabel'), document.version)}
      ${fieldMeta(t('recipientLabel'), document.recipient)}
      ${fieldMeta(t('issuedLabel'), formatDate(document.issuedAt, true))}
      ${fieldMeta(t('verificationCode'), document.verificationCode)}
      ${fieldMeta(t('signer'), signer)}
    </div>
    ${document.signature?.signatureImage ? `<img class="dialog-signature" src="${escapeHtml(document.signature.signatureImage)}" alt="${escapeHtml(t('signerSignatureAlt'))}">` : ''}
    <div class="dialog-copy">${escapeHtml(body || (state.language === 'ar' ? 'لا يوجد محتوى نصي في هذه الوثيقة.' : 'No document text is available.'))}</div>
    ${document.revokedReason ? `<p class="dialog-copy"><b>${escapeHtml(t('revoke'))}:</b> ${escapeHtml(document.revokedReason)}</p>` : ''}
  `;
  $('#modalActions').innerHTML = modalActions(document);
  $('#documentModal').hidden = false;
}

async function openDocument(id) {
  const cached = state.documents.find((document) => document.id === id);
  if (!cached) return;
  const { document } = await request(`/documents/${encodeURIComponent(id)}`);
  showDocument(document);
}

async function saveDraft(event) {
  event.preventDefault();
  const payload = documentPayload();
  if (!payload.title) return toast(t('titleRequired'), 'error');
  if (!payload.body.trim()) return toast(t('bodyRequired'), 'error');
  try {
    const path = state.editingId ? `/documents/${encodeURIComponent(state.editingId)}` : '/documents';
    const method = state.editingId ? 'PATCH' : 'POST';
    const result = await request(path, { method, body: JSON.stringify(payload) });
    state.editingId = null;
    await loadDocuments();
    setPage('archive');
    showDocument(result.document);
    toast(t('saved'));
  } catch (error) {
    toast(error.message || t('createFailed'), 'error');
  }
}

function editDraft(id) {
  const doc = state.documents.find((entry) => entry.id === id);
  if (!doc || doc.status !== 'DRAFT') return;
  state.editingId = doc.id;
  $('#docType').value = doc.type;
  $('#docTitle').value = doc.title;
  $('#docSector').value = doc.sector;
  $('#docClassification').value = doc.classification;
  $('#docRecipient').value = doc.recipient || '';
  $('#docBody').value = doc.body?.text || '';
  $('#docNotes').value = doc.body?.notes || '';
  $('#docReferences').value = (doc.body?.references || []).join(', ');
  $('#docExpiry').value = doc.expiresAt ? new Date(doc.expiresAt).toISOString().slice(0, 10) : '';
  $('#documentModal').hidden = true;
  setPage('create');
  renderPreview();
}

async function createAmendment(id) {
  try {
    const result = await request(`/documents/${encodeURIComponent(id)}/amend`, { method: 'POST', body: '{}' });
    await loadDocuments();
    $('#documentModal').hidden = true;
    editDraft(result.document.id);
    toast(t('amendDocument'));
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function actOnDocument(action, id) {
  const methods = {
    submitForApproval: ['POST', `/documents/${id}/submit`, null, t('submitted')],
    approveDocument: ['POST', `/documents/${id}/approve`, null, t('approved')],
    issueDocument: ['POST', `/documents/${id}/issue`, null, t('issuedMessage')],
    archiveDocument: ['POST', `/documents/${id}/archive`, null, t('archivedMessage')]
  };
  if (action === 'issueDocument') {
    openSignatureDialog(id);
    return;
  }
  if (action === 'approveDocument' && !window.confirm(t('confirmApprove'))) return;
  if (action === 'revokeDocument') {
    const reason = window.prompt(t('confirmRevoke'));
    if (!reason?.trim()) return;
    methods.revokeDocument = ['POST', `/documents/${id}/revoke`, { reason: reason.trim() }, t('revokedMessage')];
  }
  const operation = methods[action];
  if (!operation) return;
  try {
    await request(operation[1], { method: operation[0], body: operation[2] ? JSON.stringify(operation[2]) : '{}' });
    $('#documentModal').hidden = true;
    await loadDocuments();
    toast(operation[3]);
    const changed = state.documents.find((document) => document.id === id);
    if (changed) showDocument(changed);
  } catch (error) {
    toast(error.message, 'error');
  }
}

let signingDocumentId = null;
let signatureHasStroke = false;
let signatureDistance = 0;
let signatureLastPoint = null;
const signatureCanvas = $('#signatureCanvas');
const signatureContext = signatureCanvas.getContext('2d');

function resizeSignatureCanvas() {
  const rect = signatureCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  signatureCanvas.width = Math.round(rect.width * ratio);
  signatureCanvas.height = Math.round(rect.height * ratio);
  signatureContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  signatureContext.fillStyle = '#f2efe6';
  signatureContext.fillRect(0, 0, rect.width, rect.height);
  signatureContext.lineWidth = 2.6;
  signatureContext.lineCap = 'round';
  signatureContext.lineJoin = 'round';
  signatureContext.strokeStyle = '#20231f';
}

function clearSignature() {
  resizeSignatureCanvas();
  signatureHasStroke = false;
  signatureDistance = 0;
  signatureLastPoint = null;
}

function openSignatureDialog(id) {
  const document = state.documents.find((entry) => entry.id === id);
  if (!document || document.status !== 'APPROVED' || !can('SIGN_DOCUMENTS') || !can('ISSUE_DOCUMENTS')) {
    return toast(t('noPermission'), 'error');
  }
  signingDocumentId = id;
  $('#signatureDocumentNumber').textContent = document.documentNumber;
  $('#signatureModal').hidden = false;
  clearSignature();
  requestAnimationFrame(() => signatureCanvas.focus());
}

function signaturePoint(event) {
  const rect = signatureCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

signatureCanvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  event.preventDefault();
  signatureCanvas.setPointerCapture(event.pointerId);
  const point = signaturePoint(event);
  signatureContext.beginPath();
  signatureContext.arc(point.x, point.y, 1.3, 0, Math.PI * 2);
  signatureContext.fillStyle = '#20231f';
  signatureContext.fill();
  signatureContext.beginPath();
  signatureContext.moveTo(point.x, point.y);
  signatureLastPoint = point;
});

signatureCanvas.addEventListener('pointermove', (event) => {
  if (!signatureCanvas.hasPointerCapture(event.pointerId)) return;
  event.preventDefault();
  const point = signaturePoint(event);
  signatureDistance += Math.hypot(point.x - signatureLastPoint.x, point.y - signatureLastPoint.y);
  signatureLastPoint = point;
  signatureContext.lineTo(point.x, point.y);
  signatureContext.stroke();
  if (signatureDistance > 8) signatureHasStroke = true;
});

function stopSignatureStroke(event) {
  if (signatureCanvas.hasPointerCapture(event.pointerId)) signatureCanvas.releasePointerCapture(event.pointerId);
}
signatureCanvas.addEventListener('pointerup', stopSignatureStroke);
signatureCanvas.addEventListener('pointercancel', stopSignatureStroke);

async function confirmSignatureAndIssue() {
  if (!signingDocumentId || !signatureHasStroke) return toast(t('signatureEmpty'), 'error');
  const issueButton = $('[data-action="confirmSignature"]');
  issueButton.disabled = true;
  try {
    const signatureImage = signatureCanvas.toDataURL('image/png');
    await request(`/documents/${encodeURIComponent(signingDocumentId)}/issue`, {
      method: 'POST',
      body: JSON.stringify({ signatureImage })
    });
    const issuedId = signingDocumentId;
    signingDocumentId = null;
    $('#signatureModal').hidden = true;
    $('#documentModal').hidden = true;
    await loadDocuments();
    toast(t('issuedMessage'));
    const issued = state.documents.find((document) => document.id === issuedId);
    if (issued) showDocument(issued);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    issueButton.disabled = false;
  }
}

async function shareDocument(id) {
  try {
    const result = await request(`/documents/${encodeURIComponent(id)}/share`, {
      method: 'POST',
      body: JSON.stringify({ permissions: ['VIEW', 'VERIFY'], expiresInDays: 14 })
    });
    await navigator.clipboard?.writeText(result.url);
    toast(navigator.clipboard ? t('copied') : `${t('shareCreated')} ${result.url}`);
    window.prompt(t('shareCreated'), result.url);
  } catch (error) { toast(error.message, 'error'); }
}

async function waitForPrintAssets(root) {
  if (document.fonts?.ready) await document.fonts.ready;
  const images = [...root.querySelectorAll('img')].filter((image) => image.hasAttribute('src') && !image.hidden);
  await Promise.all(images.map(async (image) => {
    if (!image.complete) {
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error('A document image did not finish loading.'));
        }, 15000);
        const cleanup = () => {
          window.clearTimeout(timer);
          image.removeEventListener('load', loaded);
          image.removeEventListener('error', failed);
        };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('A document image failed to load.')) };
        image.addEventListener('load', loaded, { once: true });
        image.addEventListener('error', failed, { once: true });
        if (image.complete) loaded();
      });
    }
    if (!image.naturalWidth) throw new Error('A document image failed to load.');
    if (typeof image.decode === 'function') await image.decode();
  }));
}

async function printDocument(documentData) {
  const source = $('#livePreview');
  if (!source) throw new Error('The official document preview is unavailable.');
  renderPreview(documentData);

  const printRoot = document.createElement('div');
  printRoot.className = 'osd-print-root';
  printRoot.setAttribute('aria-hidden', 'true');
  const paper = source.cloneNode(true);
  paper.removeAttribute('id');
  paper.classList.add('print-document');
  paper.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
  printRoot.append(paper);
  document.body.append(printRoot);

  const cleanup = () => printRoot.remove();
  window.addEventListener('afterprint', cleanup, { once: true });
  try {
    await waitForPrintAssets(printRoot);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.print();
  } catch (error) {
    window.removeEventListener('afterprint', cleanup);
    cleanup();
    throw error;
  }
}

async function verifyIdentifier(identifier, resultTarget = $('#verifyResult')) {
  resultTarget.className = 'verify-result visible';
  resultTarget.innerHTML = `<b>${escapeHtml(state.language === 'ar' ? 'جارٍ التحقق…' : 'VERIFYING…')}</b>`;
  try {
    const result = await request(`/verify/${encodeURIComponent(identifier)}`);
    const status = result.status;
    const type = status === 'DOCUMENT VALID' ? 'valid' :
      status === 'DOCUMENT REVOKED' || status === 'DOCUMENT EXPIRED' || status === 'DOCUMENT INTEGRITY CHECK FAILED' ? 'failed' : '';
    resultTarget.className = `verify-result visible ${type}`;
    const labels = {
      'DOCUMENT VALID': t('verifyValid'),
      'DOCUMENT REVOKED': t('verifyRevoked'),
      'DOCUMENT EXPIRED': t('verifyExpired'),
      'DOCUMENT NOT FOUND': t('verifyNotFound'),
      'DOCUMENT INTEGRITY CHECK FAILED': t('verifyFailed'),
      'DOCUMENT NOT VERIFIED': t('verifyUnknown')
    };
    resultTarget.innerHTML = `<b>${escapeHtml(labels[status] || status)}</b><p>${escapeHtml(result.documentNumber || '')}${result.type ? ` · ${escapeHtml(result.type)}` : ''}${result.classification ? ` · ${escapeHtml(result.classification)}` : ''}${result.issuedAt ? ` · ${escapeHtml(formatDate(result.issuedAt, true))}` : ''}</p>`;
    return result;
  } catch (error) {
    resultTarget.className = 'verify-result visible failed';
    resultTarget.innerHTML = `<b>${escapeHtml(error.message)}</b>`;
    return null;
  }
}

async function loadAudit(documentId = '') {
  try {
    const result = await request(documentId ? `/documents/${encodeURIComponent(documentId)}/audit` : '/audit');
    const events = result.events || [];
    $('#auditRows').innerHTML = events.map((event) => `<div class="audit-row"><time class="audit-time">${escapeHtml(formatDate(event.created_at, true))}</time><div><strong>${escapeHtml(event.action)}</strong><small>${escapeHtml(event.document_id ? `${event.document_id} · v${event.version}` : 'OSD SYSTEM EVENT')}</small></div><span class="audit-actor">${escapeHtml(event.actor_label)}</span></div>`).join('');
    $('#auditEmpty').classList.toggle('visible', !events.length);
    if (documentId) {
      $('#documentModal').hidden = true;
      toast(t('auditTitle'));
    }
  } catch (error) {
    $('#auditRows').innerHTML = '';
    $('#auditEmpty').classList.add('visible');
    toast(error.message, 'error');
  }
}

async function showVersions(id) {
  try {
    const result = await request(`/documents/${encodeURIComponent(id)}/versions`);
    $('#modalContent').innerHTML = (result.versions || []).map((version) => `<div class="audit-row"><time class="audit-time">${escapeHtml(formatDate(version.created_at, true))}</time><div><strong>VERSION ${escapeHtml(version.version)}</strong><small>${escapeHtml(version.change_note || '')}</small></div><span class="audit-actor">${escapeHtml(version.content_hash.slice(0, 10))}…</span></div>`).join('');
    $('#modalActions').innerHTML = `<button class="button button-quiet" data-action="closeModal">${escapeHtml(t('close'))}</button>`;
  } catch (error) { toast(error.message, 'error'); }
}

async function loadUsers() {
  if (!can('MANAGE_USERS')) {
    $('#userList').innerHTML = `<div class="empty-state visible"><b>${escapeHtml(t('noPermission'))}</b></div>`;
    $('#addUserButton').hidden = true;
    return;
  }
  $('#addUserButton').hidden = false;
  try {
    const result = await request('/users');
    $('#userList').innerHTML = (result.users || []).map((user) => `<div class="user-row">
      <span><strong>${escapeHtml(user.display_name)}</strong><small>${escapeHtml(user.username)}</small></span>
      <select aria-label="Role" data-action="changeUserRole" data-id="${escapeHtml(user.id)}">${Object.keys(ROLE_PERMISSIONS).map((role) => `<option value="${role}" ${role === user.role ? 'selected' : ''}>${role}</option>`).join('')}</select>
      <span class="user-clearance">${escapeHtml(user.clearance)}</span>
      <button class="row-action" data-action="toggleUser" data-id="${escapeHtml(user.id)}" data-enabled="${user.enabled}" aria-label="Toggle access">${user.enabled ? '●' : '○'}</button>
    </div>`).join('') || `<div class="empty-state visible"><b>${escapeHtml(t('noUsers'))}</b></div>`;
  } catch (error) {
    $('#userList').innerHTML = `<div class="empty-state visible"><b>${escapeHtml(error.message)}</b></div>`;
  }
}

function openUserForm() {
  if (!can('MANAGE_USERS')) return toast(t('noPermission'), 'error');
  if ($('#newUserForm')) return $('#newUserForm').remove();
  const form = document.createElement('form');
  form.id = 'newUserForm';
  form.className = 'user-form';
  form.innerHTML = `<label>${escapeHtml(t('displayName'))}<input name="displayName" required maxlength="120"></label>
    <label>${escapeHtml(t('username'))}<input name="username" required minlength="3" maxlength="60"></label>
    <label>${escapeHtml(t('password'))}<input name="password" type="password" required minlength="12" autocomplete="new-password"></label>
    <label>${escapeHtml(t('role'))}<select name="role">${Object.keys(ROLE_PERMISSIONS).map((role) => `<option value="${role}">${role}</option>`).join('')}</select></label>
    <label>${escapeHtml(t('clearanceLabel'))}<select name="clearance">${CLASSIFICATIONS.map((classification) => `<option>${classification}</option>`).join('')}</select></label>
    <button class="button button-primary" type="submit">${escapeHtml(t('createUser'))}</button>`;
  $('#userList').before(form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await request('/users', { method: 'POST', body: JSON.stringify({
        ...values, clearance: values.clearance || 'INTERNAL',
        permissions: ROLE_PERMISSIONS[values.role] || ROLE_PERMISSIONS.AGENT
      }) });
      form.remove();
      await loadUsers();
      toast(t('created'));
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function userAction(action, target, value) {
  try {
    if (action === 'changeUserRole') {
      const permissions = ROLE_PERMISSIONS[value] || ROLE_PERMISSIONS.AGENT;
      const clearance = value === 'AGENT' ? 'INTERNAL' : value === 'SENIOR' ? 'SECRET' : 'TOP SECRET';
      await request(`/users/${encodeURIComponent(target)}`, { method: 'PATCH', body: JSON.stringify({ role: value, permissions, clearance }) });
    } else {
      await request(`/users/${encodeURIComponent(target)}`, { method: 'PATCH', body: JSON.stringify({ enabled: value !== 'true' }) });
    }
    await loadUsers();
    toast(t('save'));
  } catch (error) { toast(error.message, 'error'); }
}

function useTemplate(type) {
  $('#docType').value = type;
  setPage('create');
  $('#docTitle').focus();
  renderPreview();
}

function showAuthTab(tab) {
  $$('.auth-tabs button').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
  $('#loginForm').hidden = tab !== 'login';
  $('#bootstrapForm').hidden = tab !== 'bootstrap';
  $('#authMessage').textContent = '';
}

async function showShareDocument(token) {
  const result = await request(`/share/${encodeURIComponent(token)}`);
  state.shareDocument = result.document;
  setPage('center');
  state.publicMode = true;
  document.body.classList.add('public-mode');
  showAuth(false);
  const doc = result.document;
  $('#pageTitle').textContent = doc.title;
  $('#pageCaption').textContent = `${doc.documentNumber} · ${doc.classification} · ${doc.status}`;
  $('#pageEyebrow').textContent = 'SECURE DOCUMENT LINK';
  $('#documentModal').hidden = false;
  $('#modalTitle').textContent = doc.title;
  $('#modalNumber').textContent = doc.documentNumber;
  $('#modalContent').innerHTML = `<div class="dialog-meta-grid">${fieldMeta(t('fileNo'), doc.documentNumber)}${fieldMeta(t('classificationCol'), doc.classification)}${fieldMeta(t('versionLabel'), doc.version)}${fieldMeta(t('signer'), 'AUTHORIZED COMMAND')}</div>${doc.signature?.signatureImage ? `<img class="dialog-signature" src="${escapeHtml(doc.signature.signatureImage)}" alt="${escapeHtml(t('signerSignatureAlt'))}">` : ''}<div class="dialog-copy">${escapeHtml(doc.body?.text || 'Verification-only access')}</div>`;
  $('#modalActions').innerHTML = `<button class="button button-quiet" data-action="closeModal">${escapeHtml(t('close'))}</button>${result.permissions.includes('VERIFY') ? `<button class="button button-outline" data-action="verifyShared" data-code="${escapeHtml(doc.verificationCode)}">${escapeHtml(t('verifyNow'))}</button>` : ''}${result.permissions.includes('DOWNLOAD') ? `<button class="button button-primary" data-action="printShared">${escapeHtml(t('print'))}</button>` : ''}`;
}

async function showPublicVerification(code) {
  setPage('verify');
  state.publicMode = true;
  document.body.classList.add('public-mode');
  showAuth(false);
  $('#verifyInput').value = code;
  await verifyIdentifier(code);
}

async function authenticate() {
  const share = new URLSearchParams(location.search).get('share');
  const verify = new URLSearchParams(location.search).get('verify');
  if (share) {
    await showShareDocument(share);
    return;
  }
  if (verify) {
    await showPublicVerification(verify);
    return;
  }
  try {
    const result = await request('/auth/me');
    state.user = result.user;
    showAuth(false);
    $('#userName').textContent = state.user.displayName.toUpperCase();
    $('#userRole').textContent = state.user.role.replaceAll('_', ' ');
    $('#clearanceLabel').textContent = `${state.user.clearance} CLEARANCE`;
    $('#topSector').textContent = 'LOS SANTOS SECTOR';
    $('#bootstrapTab').hidden = true;
    [...$('#docClassification').options].forEach((option) => {
      option.disabled = CLASSIFICATIONS.indexOf(option.value) > CLASSIFICATIONS.indexOf(state.user.clearance);
    });
    await loadDocuments();
    if (!can('CREATE_DOCUMENTS')) $$('[data-page="create"]').forEach((button) => button.hidden = true);
    if (!can('VIEW_AUDIT_TRAIL')) $$('[data-page="audit"]').forEach((button) => button.hidden = true);
    if (!can('MANAGE_USERS')) $$('[data-page="settings"]').forEach((button) => button.hidden = true);
    setPage('center');
  } catch (error) {
    showAuth(true);
    try {
      const setup = await request('/bootstrap/status');
      state.bootstrapNeeded = setup.needed;
      $('#bootstrapTab').hidden = !setup.needed;
      if (setup.needed && !setup.configured) {
        $('#authMessage').textContent = t('setupUnavailable');
        $('#bootstrapTab').disabled = true;
      }
    } catch (statusError) {
      $('#authMessage').textContent = statusError.message;
    }
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#authMessage').textContent = '';
  try {
    await request('/auth/login', { method: 'POST', body: JSON.stringify({
      username: $('#loginUsername').value,
      password: $('#loginPassword').value
    }) });
    await authenticate();
  } catch (error) { $('#authMessage').textContent = error.message || t('loginFailed'); }
});

$('#bootstrapForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#authMessage').textContent = '';
  try {
    await request('/bootstrap', { method: 'POST', body: JSON.stringify({
      bootstrapCode: $('#bootstrapCode').value,
      displayName: $('#bootstrapName').value,
      username: $('#bootstrapUsername').value,
      password: $('#bootstrapPassword').value
    }) });
    showAuthTab('login');
    $('#loginUsername').value = $('#bootstrapUsername').value;
    toast(t('bootstrapCreated'));
  } catch (error) { $('#authMessage').textContent = error.message; }
});

$('#documentForm').addEventListener('submit', saveDraft);
$('#verifyForm').addEventListener('submit', (event) => {
  event.preventDefault();
  void verifyIdentifier($('#verifyInput').value.trim());
});

['docType', 'docTitle', 'docSector', 'docClassification', 'docRecipient', 'docBody'].forEach((id) => {
  $(`#${id}`).addEventListener('input', renderPreview);
  $(`#${id}`).addEventListener('change', renderPreview);
});
$('#archiveSearch').addEventListener('input', renderRows);
['filterType', 'filterStatus', 'filterClass'].forEach((id) => $(`#${id}`).addEventListener('change', renderRows));
$$('.nav-item[data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
$$('.toolbar-actions [data-page], .quick-action[data-page], [data-page="create"].button, .text-button[data-page], .empty-state [data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
$$('[data-auth-tab]').forEach((button) => button.addEventListener('click', () => showAuthTab(button.dataset.authTab)));
$$('.lang-toggle').forEach((button) => button.addEventListener('click', () => setLanguage(state.language === 'ar' ? 'en' : 'ar')));

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    if (action === 'logout') {
      await request('/auth/logout', { method: 'POST', body: '{}' });
      state.user = null;
      showAuth(true);
      location.reload();
    } else if (action === 'closeModal') $('#documentModal').hidden = true;
    else if (action === 'clearSignature') clearSignature();
    else if (action === 'cancelSignature') {
      signingDocumentId = null;
      $('#signatureModal').hidden = true;
    } else if (action === 'confirmSignature') await confirmSignatureAndIssue();
    else if (action === 'viewDocument') await openDocument(id);
    else if (action === 'editDraft') editDraft(id);
    else if (action === 'amendDocument') await createAmendment(id);
    else if (['submitForApproval', 'approveDocument', 'issueDocument', 'revokeDocument', 'archiveDocument'].includes(action)) await actOnDocument(action, id);
    else if (action === 'shareDocument') await shareDocument(id);
    else if (action === 'printDocument') {
      const result = await request(`/documents/${encodeURIComponent(id)}/download`, { method: 'POST', body: '{}' });
      await printDocument(result.document);
    } else if (action === 'showAudit') await loadAudit(id);
    else if (action === 'showVersions') await showVersions(id);
    else if (action === 'openUserForm') openUserForm();
    else if (action === 'resetFilters') {
      $('#archiveSearch').value = '';
      $('#filterType').value = '';
      $('#filterStatus').value = '';
      $('#filterClass').value = '';
      renderRows();
    } else if (action === 'useTemplate') useTemplate(target.dataset.type);
    else if (action === 'previewDraft') {
      renderPreview();
      toast(t('previewDraft'));
    } else if (action === 'toggleUser') await userAction(action, id, target.dataset.enabled);
    else if (action === 'verifyShared') {
      $('#documentModal').hidden = true;
      state.publicMode = false;
      setPage('verify');
      $('#verifyInput').value = target.dataset.code;
      await verifyIdentifier(target.dataset.code);
    } else if (action === 'printShared' && state.shareDocument) await printDocument(state.shareDocument);
  } catch (error) { toast(error.message, 'error'); }
});

$('#signatureModal').addEventListener('click', (event) => {
  if (event.target === $('#signatureModal')) {
    signingDocumentId = null;
    $('#signatureModal').hidden = true;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#signatureModal').hidden) {
    signingDocumentId = null;
    $('#signatureModal').hidden = true;
  }
});

document.addEventListener('change', async (event) => {
  const target = event.target.closest('[data-action="changeUserRole"]');
  if (target) await userAction('changeUserRole', target.dataset.id, target.value);
});


initSelects();
renderTemplates();
setInterval(updateClock, 1000);
updateClock();
void authenticate();