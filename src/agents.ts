/**
 * Agent definitions for the Threadbot full-placement workflow on Runware.
 *
 * What changed relative to the original OpenAI Agent Builder version:
 *   - Every node now runs on a task-appropriate Runware LLM (see
 *     src/runware/models.ts for the selection rationale). The former single
 *     generalist model is gone.
 *   - hostedMcpTool is replaced by mcpToolset (client-side MCP over
 *     streamable HTTP) with identical server labels, allowlists and URLs.
 *   - The artwork step's generate_panel_artwork_bundle tool is served by a
 *     local Runware-backed implementation (FLUX.2 flex / Recraft V4.1 Pro /
 *     BiRefNet) under the same tool name, so the Placement Bundle Compiler's
 *     instructions apply unchanged. Set THREADBOT_ARTWORK_MCP_URL to fall
 *     back to the original hosted artwork MCP instead.
 *
 * What did NOT change: agent instructions (src/instructions.ts) and output
 * schemas (src/schemas.ts) are verbatim from the original workflow.
 */

import { Agent, localToolset, mcpToolset, Toolset } from "./runware/agent.js";
import { createGeneratePanelArtworkBundleTool } from "./tools/artworkBundleTool.js";
import * as instructions from "./instructions.js";
import * as schemas from "./schemas.js";

// -----------------------------------------------------------------------------
// MCP tool definitions: kept from the original workflow.
// -----------------------------------------------------------------------------

const mcp = mcpToolset({
  serverLabel: "threadbot_policy_mcp",
  allowedTools: [
    "screen_design_policy",
    "screen_ip_risk",
    "screen_text_policy",
    "generate_policy_decision"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-policy-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp1 = mcpToolset({
  serverLabel: "threadbot_product_intelligence_mcp",
  allowedTools: [
    "search_products",
    "find_products_by_family",
    "get_product_twin",
    "get_surface_graph",
    "get_mockup_payload_rules",
    "get_template_geometry",
    "validate_design_ir_against_product",
    "get_catalog_health"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp2 = mcpToolset({
  serverLabel: "threadbot_product_intelligence_mcp",
  allowedTools: [
    "get_product_twin",
    "get_surface_graph",
    "get_mockup_payload_rules",
    "get_template_geometry",
    "validate_design_ir_against_product"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp3 = mcpToolset({
  serverLabel: "threadbot_pricing_agentbuilder_mcp",
  allowedTools: [
    "get_variant_pricing_basis",
    "calculate_product_pricing",
    "estimate_margin",
    "summarize_pricing_and_mockups"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-pricing-agentbuilder-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp4 = mcpToolset({
  serverLabel: "threadbot_product_intelligence_mcp",
  allowedTools: [
    "get_surface_graph",
    "get_mockup_payload_rules",
    "get_template_geometry",
    "validate_design_ir_against_product"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp5 = mcpToolset({
  serverLabel: "threadbot_product_intelligence_mcp",
  allowedTools: [
    "get_mockup_payload_rules",
    "get_template_geometry",
    "validate_design_ir_against_product"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

/**
 * Artwork toolset. By default generate_panel_artwork_bundle is implemented
 * locally on Runware image models; the tool name and role are unchanged so
 * the Placement Bundle Compiler instructions remain valid as written.
 */
const mcp6: Toolset = process.env.THREADBOT_ARTWORK_MCP_URL
  ? mcpToolset({
      serverLabel: "threadbot_artwork_mcp",
      allowedTools: ["generate_panel_artwork_bundle"],
      requireApproval: "never",
      serverUrl: process.env.THREADBOT_ARTWORK_MCP_URL
    })
  : localToolset("threadbot_artwork_mcp", [createGeneratePanelArtworkBundleTool()]);

const mcp7 = mcpToolset({
  serverLabel: "threadbot_printful_mockups_mcp",
  allowedTools: [
    "list_printful_mockup_styles",
    "select_printful_mockup_style_ids",
    "extract_printful_mockup_urls",
    "create_and_wait_for_printful_mockups"
  ],
  requireApproval: "never",
  serverUrl: "https://threadbot-printful-mockups-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

const mcp8 = mcpToolset({
  serverLabel: "threadbot_product_intelligence2_mcp",
  allowedTools: ["get_mockup_payload_rules"],
  requireApproval: "never",
  serverUrl: "https://threadbot-product-intelligence-mcp-2uts5km5aq-uc.a.run.app/mcp"
});

// -----------------------------------------------------------------------------
// Agent definitions. Models come from the per-node Runware registry.
// -----------------------------------------------------------------------------

export const threadbotIntakeOrchestrator = new Agent({
  name: "Threadbot Intake Orchestrator",
  instructions: instructions.THREADBOT_INTAKE_ORCHESTRATOR_INSTRUCTIONS,
  outputType: schemas.ThreadbotIntakeOrchestratorSchema
});

export const customerIntentAgent = new Agent({
  name: "Customer Intent Agent",
  instructions: instructions.CUSTOMER_INTENT_AGENT_INSTRUCTIONS,
  outputType: schemas.CustomerIntentAgentSchema
});

export const policyIpGate = new Agent({
  name: "Policy + IP Gate",
  instructions: instructions.POLICY_IP_GATE_INSTRUCTIONS,
  tools: [mcp],
  outputType: schemas.PolicyIpGateSchema
});

export const productDiscoveryAgent = new Agent({
  name: "Product Discovery Agent",
  instructions: instructions.PRODUCT_DISCOVERY_AGENT_INSTRUCTIONS,
  tools: [mcp1],
  outputType: schemas.ProductDiscoveryAgentSchema
});

export const productSelector = new Agent({
  name: "Product Selector",
  instructions: instructions.PRODUCT_SELECTOR_INSTRUCTIONS,
  tools: [mcp2],
  outputType: schemas.ProductSelectorSchema
});

export const pricingBasisAgent = new Agent({
  name: "Pricing Basis Agent",
  instructions: instructions.PRICING_BASIS_AGENT_INSTRUCTIONS,
  tools: [mcp3],
  outputType: schemas.PricingBasisAgentSchema
});

export const designProgramCompiler = new Agent({
  name: "Design Program Compiler",
  instructions: instructions.DESIGN_PROGRAM_COMPILER_INSTRUCTIONS,
  outputType: schemas.DesignProgramCompilerSchema
});

export const productSurfacePlanner = new Agent({
  name: "Product-Surface Planner",
  instructions: instructions.PRODUCT_SURFACE_PLANNER_INSTRUCTIONS,
  tools: [mcp4],
  outputType: schemas.ProductSurfacePlannerSchema
});

export const productOptionsResolver = new Agent({
  name: "Product Options Resolver",
  instructions: instructions.PRODUCT_OPTIONS_RESOLVER_INSTRUCTIONS,
  tools: [mcp8],
  outputType: schemas.ProductOptionsResolverSchema
});

export const technicalQaAgent = new Agent({
  name: "Technical QA Agent",
  instructions: instructions.TECHNICAL_QA_AGENT_INSTRUCTIONS,
  tools: [mcp5],
  outputType: schemas.TechnicalQaAgentSchema
});

export const placementBundleCompiler = new Agent({
  name: "Placement Bundle Compiler",
  instructions: instructions.PLACEMENT_BUNDLE_COMPILER_INSTRUCTIONS,
  tools: [mcp6],
  outputType: schemas.PlacementBundleCompilerSchema
});

export const mockupRenderAgent = new Agent({
  name: "Mockup Render Agent",
  instructions: instructions.MOCKUP_RENDER_AGENT_INSTRUCTIONS,
  tools: [mcp7],
  outputType: schemas.MockupRenderAgentSchema
});

export const finalResponseComposer = new Agent({
  name: "Final Response Composer",
  instructions: instructions.FINAL_RESPONSE_COMPOSER_INSTRUCTIONS,
  outputType: schemas.FinalResponseComposerSchema
});
