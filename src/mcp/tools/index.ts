import type { AnyToolDef } from '../runtime.js';
import {
  crawlSiteTool,
  auditIssuesTool,
  pageInspectTool,
  internalLinksTool,
  linkOpportunitiesTool,
  crawlDiffTool,
  crawlHistoryTool,
} from './site.js';
import { keywordIdeasTool, keywordMetricsTool, clusterKeywordsTool, keywordDifficultyTool } from './keywords.js';
import {
  serpTool,
  rankCheckTool,
  competitorsTool,
  contentGapTool,
  domainAuthorityTool,
  backlinksTool,
  linkGapTool,
  rankChangesTool,
} from './serp.js';
import { gscSitesTool, gscPerformanceTool, gscOpportunitiesTool } from './gsc.js';
import { contentBriefTool, contentScoreTool, pageOptimizeTool } from './content.js';
import { pseoDiscoverTool, pseoBuildPlanTool, pseoIndexRiskTool } from './pseo.js';
import { aiVisibilityTool, pageSpeedTool } from './ai.js';
import {
  capabilitiesTool,
  projectSetTool,
  projectListTool,
  usageTool,
  cacheClearTool,
  nextActionsTool,
} from './meta.js';

/**
 * The full tool registry.
 *
 * Ordered by how an agent naturally moves through the work — orientation, then
 * site analysis, then keywords, then competitive data, then writing, then
 * scaled publishing. Some MCP clients surface tools in registration order, so
 * this ordering is itself a hint about the intended workflow.
 */
export const ALL_TOOLS: AnyToolDef[] = [
  // Orientation
  capabilitiesTool,
  nextActionsTool,

  // Site crawling and auditing — works with no keys
  crawlSiteTool,
  auditIssuesTool,
  pageInspectTool,
  internalLinksTool,
  linkOpportunitiesTool,
  crawlDiffTool,
  crawlHistoryTool,

  // Keyword research — discovery is free, metrics are provider-gated
  keywordIdeasTool,
  keywordMetricsTool,
  keywordDifficultyTool,
  clusterKeywordsTool,

  // Your own performance — free via Search Console
  gscSitesTool,
  gscPerformanceTool,
  gscOpportunitiesTool,

  // Competitive and SERP — provider-gated
  serpTool,
  rankCheckTool,
  rankChangesTool,
  competitorsTool,
  contentGapTool,
  domainAuthorityTool,
  backlinksTool,
  linkGapTool,

  // Writing
  contentBriefTool,
  contentScoreTool,
  pageOptimizeTool,

  // AI-era visibility and performance
  aiVisibilityTool,
  pageSpeedTool,

  // Programmatic SEO
  pseoDiscoverTool,
  pseoBuildPlanTool,
  pseoIndexRiskTool,

  // Housekeeping
  projectSetTool,
  projectListTool,
  usageTool,
  cacheClearTool,
];

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.name);
