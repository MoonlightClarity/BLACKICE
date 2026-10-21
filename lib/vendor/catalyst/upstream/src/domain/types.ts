export type SelectionAnchor = {
  pageIndex: number;
  rect: unknown;
  textLines: unknown;
};

export type DocumentRecord = {
  id: string;
  name: string;
  path: string | null;
  openedAt: string;
  lastOpenedAt: string;
};

export type SourceGlyphPointer = {
  page: number;
  index: number;
};

export type SourceSelectionRange = {
  start: SourceGlyphPointer;
  end: SourceGlyphPointer;
};

export type PendingSelection = {
  documentId: string;
  documentName: string;
  quote: string;
  pageIndex: number;
  anchors: SelectionAnchor[];
  sourceRange?: SourceSelectionRange;
  capturedAt: string;
};

export type AnnotationKind = "excerpt" | "highlight";
export type AnnotationRole = AnnotationKind;

export type AnalyticMarkPurpose =
  | "key-evidence"
  | "contradiction"
  | "uncertain"
  | "follow-up";

// Source semantics are faceted. These roles describe what the source says,
// never whether Catalyst or the analyst endorses the passage.
export type SourceEpistemicRole =
  | "observation-report"
  | "assumption"
  | "hypothesis"
  | "judgment";

export type SourceArgumentRole =
  | "reason"
  | "conclusion"
  | "caveat"
  | "objection";

export type SourceSemanticFacets = {
  epistemicRoles?: SourceEpistemicRole[];
  argumentRoles?: SourceArgumentRole[];
};

export type Annotation = {
  id: string;
  documentId: string;
  quote: string;
  pageIndex: number;
  anchors: SelectionAnchor[];
  sourceRange?: SourceSelectionRange;
  kind: AnnotationKind;
  // Compatibility only: legacy analytic/source-semantic metadata remains readable.
  // Current PDF annotation tools do not write either field.
  analyticPurpose?: AnalyticMarkPurpose;
  sourceSemantics?: SourceSemanticFacets;
  visual?: "frame";
  createdAt: string;
};

export type ViewerMarkup = {
  id: string;
  documentId: string;
  pageIndex: number;
  formatVersion: 1;
  annotationJson: string;
  contextDataBase64: string | null;
  contextMimeType: string | null;
  createdAt: string;
  updatedAt: string;
};


export type CapabilityProfileId = "simple" | "research" | "analytical" | "full";

export type CapabilityId =
  | "analyticalRoles"
  | "typedRelationships"
  | "confidence"
  | "methods";

export type CapabilityState = {
  profile: CapabilityProfileId;
  overrides: Partial<Record<CapabilityId, boolean>>;
};

export type AnalyticalRole =
  | "note"
  | "claim"
  | "assumption"
  | "hypothesis"
  | "question"
  | "entity"
  | "event";

export type ConfidenceLevel = "low" | "medium" | "high";

export type NoteSemantics = {
  roles: AnalyticalRole[];
  confidence: ConfidenceLevel | null;
};

export type RelationshipType =
  | "related-to"
  | "supports"
  | "contradicts"
  | "depends-on"
  | "derived-from"
  | "about"
  | "precedes";

export type Relationship = {
  id: string;
  fromId: string;
  toId: string;
  type: RelationshipType;
  directed: boolean;
  label: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipScope = "outline" | "method" | "cross";



export type GraphPoint = {
  x: number;
  y: number;
};

export type GraphCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type GraphViewState = {
  positions: Record<string, GraphPoint>;
  camera: GraphCamera;
};

export type AnalysisRoot = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type OutlineReferenceItem = {
  id: string;
  kind: "reference";
  itemId: string;
  parentItemId: string;
  siblingOrder: number;
};

export type OutlineGroupItem = {
  id: string;
  kind: "group";
  label: string;
  parentItemId: string;
  siblingOrder: number;
};

export type OutlineQueryItem = {
  id: string;
  kind: "query";
  label: string;
  query: string;
  parentItemId: string;
  siblingOrder: number;
};

export type OutlineItem = OutlineReferenceItem | OutlineGroupItem | OutlineQueryItem;

export type Outline = {
  id: string;
  analysisRootId: string;
  rootItemId: string;
  items: Record<string, OutlineItem>;
};

export type OutlineSessionState = {
  collapsedItemIds: string[];
};

export type Note = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteAnnotationLink = {
  noteId: string;
  annotationId: string;
  createdAt: string;
};

export type NoteLink = {
  fromNoteId: string;
  toNoteId: string;
  createdAt: string;
};

export type TechniqueCategory =
  | "diagnostic"
  | "contrarian"
  | "imaginative"
  | "other";

export type TechniqueFamily =
  | "intelligence" | "forecasting" | "decision" | "systems" | "safety"
  | "quality" | "research" | "design" | "security" | "policy" | "economics"
  | "geospatial" | "legal" | "operations-research" | "literary" | "religious-studies"
  | "general" | "custom";

export type TechniqueResponseKind = "short-text" | "long-text" | "list";

export type TechniqueStepDefinition = {
  id: string;
  title: string;
  prompt: string;
  responseKind: TechniqueResponseKind;
  placeholder?: string;
};

export type TechniqueDefinition = {
  id: string;
  name: string;
  summary: string;
  category: TechniqueCategory;
  family?: TechniqueFamily;
  cluster?: string;
  builtIn: boolean;
  version: number;
  steps: TechniqueStepDefinition[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type TechniqueRun = {
  id: string;
  /** Parent method in the workspace method tree. Null means a root-level method. */
  parentRunId?: string | null;
  /** Stable sibling order within parentRunId. */
  sequenceIndex?: number | null;
  definitionId: string;
  definitionVersion: number;
  definitionSnapshot: TechniqueDefinition;
  responses: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceState = {
  analysisRoot: AnalysisRoot;
  outline: Outline;
  outlineSession: OutlineSessionState;
  documents: Record<string, DocumentRecord>;
  annotations: Record<string, Annotation>;
  viewerMarkups: Record<string, ViewerMarkup>;
  notes: Record<string, Note>;
  links: NoteAnnotationLink[];
  noteLinks: NoteLink[];
  techniqueRuns: Record<string, TechniqueRun>;
  pendingSelection: PendingSelection | null;
  activeDocumentId: string | null;
  activeNoteId: string | null;
  graphView: GraphViewState;
  capabilities: CapabilityState;
  noteSemantics: Record<string, NoteSemantics>;
  relationships: Record<string, Relationship>;
  methodRelationships: Record<string, Relationship>;
  crossRelationships: Record<string, Relationship>;
  annotationRoles: Record<string, AnnotationRole[]>;
};
