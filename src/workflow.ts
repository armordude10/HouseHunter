import { z } from "zod";
import { runAgent, type AgentDef, type AgentResult } from "./runware-engine.js";
import { McpHub, THREADBOT_MCP_SERVERS, type AgentTool, type McpToolRef } from "./tools.js";
import { buildArtworkTool } from "./artwork.js";
import {
  type ThreadbotAgent,
  threadbotIntakeOrchestrator,
  customerIntentAgent,
  policyIpGate,
  productDiscoveryAgent,
  productSelector,
  pricingBasisAgent,
  designProgramCompiler,
  productSurfacePlanner,
  productOptionsResolver,
  technicalQaAgent,
  placementBundleCompiler,
  mockupRenderAgent,
  finalResponseComposer,
} from "./agents.js";

/**
 * THREADBOT FULL-PLACEMENT WORKFLOW — RUNWARE RUNNER
 *
 * This is the hand-rolled replacement for the OpenAI-Agents `Runner` +
 * `withTrace` orchestration. The node order, state passing, and truth-gate
 * short-circuits mirror the original workflow exactly.
 *
 * HARD INVARIANT (unchanged):
 *   After product selection, the complete design artifact is
 *   placement_bundle_json. No downstream node may treat one placement_file_url
 *   as the whole product design. A run can only become mockup-ready when:
 *     - supported placements are discovered from product truth,
 *     - required placements are identified from product/mockup/design/coverage,
 *     - every required placement has a placement job,
 *     - every required generated/renderable placement has a real public URL,
 *     - the submitted placement files match the mockup payload rules,
 *     - required product options are resolved.
 */

type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (
  workflow: WorkflowInput
): Promise<AgentResult<any>> => {
  const hub = new McpHub({ bearer: process.env.THREADBOT_MCP_BEARER });
  const artworkTool = buildArtworkTool();

  // Resolve a ThreadbotAgent's tool refs into live AgentTools, then run it.
  const run = async <T extends z.ZodTypeAny>(
    agent: ThreadbotAgent<T>,
    userText: string
  ): Promise<AgentResult<z.infer<T>>> => {
    const tools: AgentTool[] = [];
    if (agent.mcpRefs?.length) {
      const refs: McpToolRef[] = agent.mcpRefs.map((r) => ({
        serverLabel: r.serverLabel,
        serverUrl: THREADBOT_MCP_SERVERS[r.serverLabel],
        allowedTools: r.allowedTools,
      }));
      tools.push(...(await hub.buildTools(refs)));
    }
    if (agent.usesArtworkTool) tools.push(artworkTool);

    const def: AgentDef<T> = { ...agent, tools };
    return runAgent(def, userText);
  };

  try {
    const state: Record<string, any> = {
      run_id: null,
      raw_user_request: null,
    };

    // -------------------------------------------------------------------------
    // Intake.
    // -------------------------------------------------------------------------
    const intakeResult = await run(
      threadbotIntakeOrchestrator,
      `Initialize a Threadbot run.
The raw customer request is exactly the text below, excluding these wrapper instructions:
${workflow.input_as_text}
Set raw_user_request to only the raw customer request text above.`
    );
    state.run_id = intakeResult.output_parsed.run_id;
    state.raw_user_request = intakeResult.output_parsed.raw_user_request;

    // -------------------------------------------------------------------------
    // Customer intent.
    // -------------------------------------------------------------------------
    const intentResult = await run(
      customerIntentAgent,
      `run_id:
${state.run_id}
MESSY CUSTOMER PROMPT:
${state.raw_user_request}
Return structured customer intent plus compact downstream handoff strings.`
    );
    state.intent_input_text = intentResult.output_parsed.intent_input_text;
    state.policy_input_text = intentResult.output_parsed.policy_input_text;

    // -------------------------------------------------------------------------
    // Policy + IP gate.
    // -------------------------------------------------------------------------
    const policyResult = await run(
      policyIpGate,
      `run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
Parsed customer intent for policy review:
${state.policy_input_text}
Use the attached policy MCP tools.
Return a policy decision and a product_discovery_input_text handoff.`
    );
    state.product_discovery_input_text = policyResult.output_parsed.product_discovery_input_text;

    // -------------------------------------------------------------------------
    // Product discovery.
    // -------------------------------------------------------------------------
    const discoveryResult = await run(
      productDiscoveryAgent,
      `Approved product discovery input:
${state.product_discovery_input_text}
Required:
Call get_catalog_health.
Call search_products using the inferred product query.
Call find_products_by_family if preferred product family is available.
Return real candidate products only.
Do not make final product selection.
Create product_candidates_text for the Product Selector.`
    );
    state.product_candidates_text = discoveryResult.output_parsed.product_candidates_text;
    state.run_id = discoveryResult.output_parsed.run_id;

    // -------------------------------------------------------------------------
    // Product selection.
    // -------------------------------------------------------------------------
    const selectorResult = await run(
      productSelector,
      `Select and validate the best product for this Threadbot request.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
Approved product discovery input:
${state.product_discovery_input_text}
Discovered product candidates:
${state.product_candidates_text}
Required:
Pick the safest internal product candidate for the customer request.
Validate the product through product-intelligence tools.
Select a matching variant.
Select the primary anchor placement.
Set placement_coverage_policy. Default to full_product_coverage unless the customer explicitly requested single-placement only.
Validate that the primary anchor placement is supported.
Validate that a surface graph exists.
Validate mockup payload rules exist.
Return selected_product_text for downstream nodes.
Do not generate artwork. Do not create mockups. Do not expose supplier/backend details to the customer.`
    );
    state.selected_product_text = selectorResult.output_parsed.selected_product_text;
    state.selected_product_id = selectorResult.output_parsed.selected_product_id_text;
    state.selected_variant_id = selectorResult.output_parsed.selected_variant_id_text;
    state.selected_primary_placement =
      selectorResult.output_parsed.selected_primary_placement_text;
    state.placement_coverage_policy =
      selectorResult.output_parsed.selected_product.placement_coverage_policy;
    if (selectorResult.output_parsed.truth_gates.can_continue !== true) return selectorResult;

    // -------------------------------------------------------------------------
    // Pricing basis.
    // -------------------------------------------------------------------------
    const pricingResult = await run(
      pricingBasisAgent,
      `Fetch and classify pricing basis for the selected product/variant.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
selected_primary_placement:
${state.selected_primary_placement}
Required:
Use get_variant_pricing_basis first.
Determine whether pricing is provider/product/variant backed, missing, helper-only, or unknown.
Do not treat caller-provided base_cost as provider truth.
Create pricing_basis_text for downstream design and commerce nodes.
For this mockup path, allow design to continue if pricing is missing but honestly marked.`
    );
    state.pricing_basis_text = pricingResult.output_parsed.pricing_basis_text;

    // -------------------------------------------------------------------------
    // Design program.
    // -------------------------------------------------------------------------
    const designResult = await run(
      designProgramCompiler,
      `Compile the Threadbot master design program.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
selected_primary_placement:
${state.selected_primary_placement}
placement_coverage_policy:
${state.placement_coverage_policy}
pricing_basis:
${state.pricing_basis_text}
Required:
Compile the customer request into a product-aware master design program.
Respect the verified selected product and primary anchor placement.
Respect placement_coverage_policy.
Respect all customer constraints, especially forbidden text/logos.
Do not generate artwork.
Do not create a mockup.
Create master_design_ir_json.
Create design_program_text for downstream surface planning and artwork generation.`
    );
    state.design_program_text = designResult.output_parsed.design_program_text;
    state.master_design_ir_json = designResult.output_parsed.master_design_ir_json;

    // -------------------------------------------------------------------------
    // Surface plan.
    // -------------------------------------------------------------------------
    const surfaceResult = await run(
      productSurfacePlanner,
      `Create the complete product-specific surface plan.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
selected_primary_placement:
${state.selected_primary_placement}
placement_coverage_policy:
${state.placement_coverage_policy}
design_program:
${state.design_program_text}
master_design_ir_json:
${state.master_design_ir_json}
Required:
Verify surface graph.
Verify template geometry if available/needed.
Verify mockup payload rules.
Validate design IR against product.
Discover all supported placements.
Identify required placements.
Create placement_jobs for every required placement and any optional placements included by full_product_coverage.
Do not collapse this to front-only unless the product has no other renderable placements or customer explicitly requested one placement only.
Create surface_plan_json for downstream Technical QA and Placement Bundle Compiler.`
    );
    state.surface_plan_text = surfaceResult.output_parsed.surface_plan_text;
    state.surface_plan_json = surfaceResult.output_parsed.surface_plan_json;
    state.supported_placements_json = JSON.stringify(
      surfaceResult.output_parsed.surface_plan.supported_placements
    );
    state.required_placements_json = JSON.stringify(
      surfaceResult.output_parsed.surface_plan.required_placements
    );
    state.surface_plan_can_continue = surfaceResult.output_parsed.truth_gates.can_continue;
    if (state.surface_plan_can_continue !== true) return surfaceResult;

    // -------------------------------------------------------------------------
    // Product options.
    // -------------------------------------------------------------------------
    const optionsResult = await run(
      productOptionsResolver,
      `Resolve required mockup product options for this Threadbot run.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
selected_primary_placement:
${state.selected_primary_placement}
placement_coverage_policy:
${state.placement_coverage_policy}
design_program:
${state.design_program_text}
surface_plan_json:
${state.surface_plan_json}
Required:
Call get_mockup_payload_rules for the selected product.
Identify required product_options for mockup generation.
If stitch_color is required, choose exactly black or white in lowercase.
Choose stitch_color based on the design concept, selected product color, and expected seam/edge/background color.
Create product_options_json as a compact JSON array string.
Create product_options_text for Technical QA and Mockup Render Agent.
Do not ask the customer to choose stitch_color unless it is truly impossible to infer.`
    );
    state.product_options_json = optionsResult.output_parsed.product_options_json;
    state.product_options_text = optionsResult.output_parsed.product_options_text;
    state.stitch_color = optionsResult.output_parsed.stitch_color;
    state.product_options_can_continue = optionsResult.output_parsed.truth_gates.can_continue;
    if (state.product_options_can_continue !== true) return optionsResult;

    // -------------------------------------------------------------------------
    // Technical QA.
    // -------------------------------------------------------------------------
    const qaResult = await run(
      technicalQaAgent,
      `Run technical QA before placement-bundle generation and mockup generation.
run_id:
${state.run_id}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
placement_coverage_policy:
${state.placement_coverage_policy}
design_program:
${state.design_program_text}
master_design_ir_json:
${state.master_design_ir_json}
surface_plan_json:
${state.surface_plan_json}
surface_plan:
${state.surface_plan_text}
resolved_product_options:
${state.product_options_text}
product_options_json:
${state.product_options_json}
stitch_color:
${state.stitch_color}
Required:
Validate placement compatibility.
Validate full required placement coverage.
Validate mockup payload rules.
Validate template geometry if needed.
Validate required product options.
If stitch_color is required, confirm it is exactly black or white in lowercase.
Identify blocked placement jobs.
Fail if full_product_coverage collapsed to only the primary placement while other renderable placements exist.
Return technical_qa_pass.
Create technical_qa_text for downstream nodes.`
    );
    state.technical_qa_text = qaResult.output_parsed.technical_qa_text;
    state.technical_qa_pass = qaResult.output_parsed.technical_qa_pass;
    if (state.technical_qa_pass !== true) return qaResult;

    // -------------------------------------------------------------------------
    // Placement bundle.
    // -------------------------------------------------------------------------
    const bundleResult = await run(
      placementBundleCompiler,
      `Generate the complete product placement bundle.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
placement_coverage_policy:
${state.placement_coverage_policy}
design_program:
${state.design_program_text}
master_design_ir_json:
${state.master_design_ir_json}
surface_plan_json:
${state.surface_plan_json}
surface_plan:
${state.surface_plan_text}
technical_qa:
${state.technical_qa_text}
resolved_product_options:
${state.product_options_text}
Required:
Parse surface_plan_json.
Iterate over every placement_job.
Generate, derive, slice, repeat, mirror, or blank every placement according to design_action.
Do not skip any required placement.
Do not collapse the run to one primary/front placement.
Return placement_bundle_json.
Return submitted_placement_files for mockup rendering.
Fail honestly if any required placement cannot be generated or derived.`
    );
    state.placement_bundle_json = bundleResult.output_parsed.placement_bundle_json;
    state.placement_bundle_text = bundleResult.output_parsed.placement_bundle_text;
    state.placement_bundle_status = bundleResult.output_parsed.generation_status;
    state.placement_bundle_complete = bundleResult.output_parsed.bundle_truth_gates.can_continue;
    state.mockup_submitted_placements_json = JSON.stringify(
      bundleResult.output_parsed.placement_bundle.submitted_placement_files
    );
    state.missing_placements_json = JSON.stringify(
      bundleResult.output_parsed.placement_bundle.missing_required_placements
    );
    if (state.placement_bundle_complete !== true) return bundleResult;

    // -------------------------------------------------------------------------
    // Mockup render.
    // -------------------------------------------------------------------------
    const mockupResult = await run(
      mockupRenderAgent,
      `Generate a real product mockup from the complete placement bundle.
run_id:
${state.run_id}
selected_product:
${state.selected_product_text}
selected_product_id:
${state.selected_product_id}
selected_variant_id:
${state.selected_variant_id}
placement_coverage_policy:
${state.placement_coverage_policy}
surface_plan_json:
${state.surface_plan_json}
placement_bundle_json:
${state.placement_bundle_json}
submitted_placement_files:
${state.mockup_submitted_placements_json}
resolved_product_options:
${state.product_options_text}
product_options_json:
${state.product_options_json}
stitch_color:
${state.stitch_color}
Required:
Parse surface_plan_json.
Parse placement_bundle_json.
Extract submitted_placement_files.
Validate all required renderable placements are present before calling mockup task.
Use list_printful_mockup_styles or select_printful_mockup_style_ids to choose valid mockup style IDs.
Use create_and_wait_for_printful_mockups to create and wait for the real mockup task.
Submit all placement files from the placement bundle that must render in mockup.
Include product_options with lowercase stitch_color when required.
Use extract_printful_mockup_urls to extract real returned mockup URLs if needed.
Do not invent mockup URLs.
If required placements are missing, return invalid_request with next_action=regenerate_missing_placements.
If mockup URLs are returned, set mockup_status=completed and put the primary URL in mockup_url.`
    );
    state.mockup_result_text = mockupResult.output_parsed.mockup_result_text;
    state.mockup_url = mockupResult.output_parsed.mockup_url;
    state.mockup_status = mockupResult.output_parsed.mockup_status;
    state.mockup_retryable = mockupResult.output_parsed.retryable;
    state.mockup_retry_after_seconds = mockupResult.output_parsed.retry_after_seconds;
    state.mockup_next_action = mockupResult.output_parsed.next_action;

    // -------------------------------------------------------------------------
    // Final response.
    // -------------------------------------------------------------------------
    const finalResult = await run(
      finalResponseComposer,
      `Compose the final Threadbot customer response.
run_id:
${state.run_id}
raw_user_request:
${state.raw_user_request}
selected_product:
${state.selected_product_text}
pricing_basis:
${state.pricing_basis_text}
design_program:
${state.design_program_text}
surface_plan:
${state.surface_plan_text}
surface_plan_json:
${state.surface_plan_json}
technical_qa:
${state.technical_qa_text}
placement_bundle_text:
${state.placement_bundle_text}
placement_bundle_json:
${state.placement_bundle_json}
placement_bundle_status:
${state.placement_bundle_status}
placement_bundle_complete:
${state.placement_bundle_complete}
product_options:
${state.product_options_text}
mockup_result:
${state.mockup_result_text}
primary_mockup_url:
${state.mockup_url}
mockup_status:
${state.mockup_status}
mockup_retryable:
${state.mockup_retryable}
mockup_retry_after_seconds:
${state.mockup_retry_after_seconds}
mockup_next_action:
${state.mockup_next_action}
Required:
If mockup_url is present and mockup_status is completed, return success.
If mockup_status is rate_limited and mockup_retryable is true, return needs_retry.
If mockup_status is timeout or tool_error and mockup_retryable is true, return needs_retry.
If mockup_status is invalid_request, return failed or needs_revision without pretending the design failed.
If placement_bundle_complete is false, do not claim the design is ready.
If the issue is an internal placement-bundle issue, do not ask the customer to choose technical options unless there is no reasonable internal choice.
If mockup_url is missing, do not invent one.
Do not expose internal IDs, backend system names, provider source tables, raw tool names, or technical product option implementation details to the customer.
Do not invent anything.`
    );
    return finalResult;
  } finally {
    await hub.close();
  }
};
