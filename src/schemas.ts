import { z } from "zod";

/**
 * THREADBOT FULL-PLACEMENT WORKFLOW — SCHEMAS
 *
 * These Zod schemas are ported VERBATIM from the original OpenAI-Agents
 * implementation. They define the hard structured-output contract for every
 * node in the pipeline and are NOT to be changed without explicit approval.
 *
 * Under the Runware migration they serve two roles:
 *   1. They are converted to JSON Schema (see runware-engine.ts) and sent to
 *      Runware textInference as the `strict` structured-output contract.
 *   2. They re-validate the model's JSON response before it is handed to the
 *      next node.
 */

// -----------------------------------------------------------------------------
// Shared schema helpers.
// -----------------------------------------------------------------------------
export const CoveragePolicySchema = z.enum([
  "single_requested_only",
  "full_product_coverage",
  "all_required_placements",
  "all_supported_placements",
]);

export const PlacementDesignActionSchema = z.enum([
  "generate_unique_art",
  "derive_from_master",
  "slice_from_master",
  "repeat_pattern",
  "mirror_from_pair",
  "leave_blank",
]);

export const MappingModeSchema = z.enum([
  "hero_crop",
  "full_bleed_expand",
  "pattern_tile",
  "motif_extract",
  "mirror",
  "continuation",
  "center_badge",
  "edge_wrap",
  "label_lockup",
  "blank",
]);

export const PlacementJobSchema = z.object({
  job_id: z.string(),
  placement: z.string(),
  worker_type: z.enum([
    "master",
    "hero",
    "overlay",
    "wrap",
    "side",
    "detail",
    "embroidery",
    "label",
    "pattern",
  ]),
  surface_role: z.string(),
  technique: z.string(),
  must_generate: z.boolean(),
  must_render_in_mockup: z.boolean(),
  design_action: PlacementDesignActionSchema,
  source_job_id: z.string().nullable(),
  mapping_rule: z.object({
    mode: MappingModeSchema,
    source: z.enum(["master_canvas", "primary_placement", "pattern_layer", "none"]),
    anchor: z.string(),
    scale_strategy: z.string(),
    preserve_subject: z.boolean(),
    continuity_edges: z.array(z.string()),
  }),
  geometry_contract: z.object({
    geometry_required: z.boolean(),
    geometry_available: z.boolean(),
    width_px: z.any(),
    height_px: z.any(),
    dpi: z.any(),
    safe_area_known: z.boolean(),
    bleed_known: z.boolean(),
    mask_known: z.boolean(),
    notes: z.string(),
  }),
  depends_on: z.array(z.string()),
  must_preserve: z.array(z.string()),
  must_avoid: z.array(z.string()),
  output_contract: z.object({
    file_type: z.enum(["png"]),
    transparent_background: z.boolean(),
    public_url_required: z.boolean(),
  }),
});

// -----------------------------------------------------------------------------
// Agent output schemas.
// -----------------------------------------------------------------------------
export const ThreadbotIntakeOrchestratorSchema = z.object({
  run_id: z.string(),
  raw_user_request: z.string(),
  pipeline_stage: z.enum(["intake_initialized"]),
  next_node: z.enum(["Save Intake State"]),
  errors: z.array(z.string()),
});

export const CustomerIntentAgentSchema = z.object({
  run_id: z.string(),
  raw_user_request: z.string(),
  customer_intent: z.object({
    product_goal: z.string(),
    product_category_terms: z.array(z.string()),
    inferred_product_query: z.string(),
    preferred_product_family: z.string(),
    style_terms: z.array(z.string()),
    subject: z.string(),
    mood_terms: z.array(z.string()),
    palette_terms: z.array(z.string()),
    required_text: z.array(z.string()),
    forbidden_text: z.array(z.string()),
    placement_preference: z.array(z.string()),
    placement_inference_status: z.enum(["explicit", "inferred_default", "unknown"]),
    requested_full_coverage: z.boolean(),
    audience: z.any(),
    occasion: z.any(),
    personalization_notes: z.array(z.string()),
    ambiguities: z.array(z.string()),
    risk_flags: z.array(z.string()),
  }),
  intent_input_text: z.string(),
  policy_input_text: z.string(),
  next_node: z.enum(["Save Intent State"]),
  errors: z.array(z.string()),
});

export const PolicyIpGateSchema = z.object({
  run_id: z.string(),
  raw_user_request: z.string(),
  policy: z.object({
    policy_status: z.enum(["allow", "review", "block"]),
    can_continue: z.boolean(),
    flags: z.array(z.string()),
    tool_checks_performed: z.array(
      z.enum([
        "screen_design_policy",
        "screen_ip_risk",
        "screen_text_policy",
        "generate_policy_decision",
      ])
    ),
    safe_rewrite_if_needed: z.any(),
    internal_explanation: z.string(),
  }),
  product_discovery_input_text: z.string(),
  next_node: z.enum(["Save Policy State"]),
  errors: z.array(z.string()),
});

export const ProductDiscoveryAgentSchema = z.object({
  run_id: z.string(),
  catalog_health: z.object({
    checked: z.boolean(),
    ok: z.boolean(),
    products: z.any(),
    product_twins: z.any(),
    variants: z.any(),
    source: z.enum(["threadbot_product_intelligence_mcp"]),
  }),
  product_candidates: z.array(
    z.object({
      product_id: z.any(),
      name: z.string(),
      canonical_family: z.string(),
      candidate_source: z.enum(["search_products", "find_products_by_family", "both"]),
      raw_candidate_rank: z.any(),
      intent_match_score: z.number(),
      default_safe_score: z.number(),
      selection_warnings: z.array(z.string()),
      disqualifiers: z.array(z.string()),
      why_candidate_matters: z.string(),
    })
  ),
  product_candidates_text: z.string(),
  candidate_truth: z.object({
    catalog_health_checked: z.boolean(),
    search_products_called: z.boolean(),
    find_products_by_family_called: z.boolean(),
    source_service: z.enum(["threadbot_product_intelligence_mcp"]),
    final_selection_made: z.boolean(),
    notes: z.array(z.string()),
  }),
  next_node: z.enum(["Save Product Discovery State"]),
  errors: z.array(z.string()),
});

export const ProductSelectorSchema = z.object({
  run_id: z.string(),
  selected_product: z.object({
    product_id: z.any(),
    product_name: z.string(),
    canonical_family: z.string(),
    selected_variant_id: z.any(),
    selected_variant_name: z.string(),
    selected_color: z.string(),
    primary_placement: z.string(),
    primary_technique: z.string(),
    placement_coverage_policy: CoveragePolicySchema,
    selection_reason: z.string(),
    rejected_candidate_notes: z.array(z.string()),
  }),
  selected_product_id_text: z.string(),
  selected_variant_id_text: z.string(),
  selected_primary_placement_text: z.string(),
  selected_product_text: z.string(),
  validation_summary: z.object({
    product_twin_checked: z.boolean(),
    surface_graph_checked: z.boolean(),
    template_geometry_checked: z.boolean(),
    mockup_payload_rules_checked: z.boolean(),
    design_ir_validation_checked: z.boolean(),
    tool_sources: z.array(
      z.enum([
        "get_product_twin",
        "get_surface_graph",
        "get_template_geometry",
        "get_mockup_payload_rules",
        "validate_design_ir_against_product",
      ])
    ),
  }),
  truth_gates: z.object({
    product_exists: z.boolean(),
    variant_exists: z.boolean(),
    color_match: z.boolean(),
    primary_placement_supported: z.boolean(),
    surface_graph_available: z.boolean(),
    mockup_rules_available: z.boolean(),
    default_safe_match: z.boolean(),
    can_continue: z.boolean(),
  }),
  next_node: z.enum(["Save Product Selection State"]),
  errors: z.array(z.string()),
});

export const PricingBasisAgentSchema = z.object({
  run_id: z.string(),
  pricing_basis: z.object({
    ok: z.boolean(),
    provider: z.any(),
    product_id: z.any(),
    variant_id: z.any(),
    currency: z.any(),
    pricing_source_status: z.enum([
      "printful_variant_prices_payload_backed",
      "missing_price_payload",
      "helper_only",
      "unknown",
      "tool_error",
    ]),
    source_table: z.any(),
    source_href: z.any(),
    synced_at: z.any(),
    selected_components: z.object({
      variant_technique_price: z.any(),
      placement_price: z.any(),
      estimated_component_total: z.any(),
    }),
    tool_sources: z.array(
      z.enum([
        "get_variant_pricing_basis",
        "calculate_product_pricing",
        "estimate_margin",
        "summarize_pricing_and_mockups",
      ])
    ),
  }),
  pricing_basis_text: z.string(),
  pricing_source_status: z.enum([
    "printful_variant_prices_payload_backed",
    "missing_price_payload",
    "helper_only",
    "unknown",
    "tool_error",
  ]),
  pricing_truth_verified: z.boolean(),
  can_continue_to_design: z.boolean(),
  next_node: z.enum(["Save Pricing State"]),
  errors: z.array(z.string()),
});

export const DesignProgramCompilerSchema = z.object({
  run_id: z.string(),
  design_program: z.object({
    design_goal: z.string(),
    placement_coverage_policy: CoveragePolicySchema,
    master_surface_strategy: z.enum([
      "single_master_then_slice",
      "multi_surface_unique_art",
      "repeat_pattern_system",
      "hybrid_master_plus_unique_details",
    ]),
    primary_subject: z.object({
      description: z.string(),
      role: z.enum(["hero", "supporting", "texture", "typography", "none"]),
      duplication_policy: z.enum([
        "single_instance",
        "repeat_allowed",
        "do_not_duplicate_full_subject",
      ]),
    }),
    secondary_motifs: z.array(z.string()),
    style_system: z.array(z.string()),
    palette: z.object({
      base_product_color: z.string(),
      primary_art_colors: z.array(z.string()),
      accent_colors: z.array(z.string()),
      contrast_strategy: z.string(),
    }),
    mood_language: z.array(z.string()),
    typography_policy: z.object({
      text_allowed: z.boolean(),
      required_text: z.array(z.string()),
      forbidden_text: z.array(z.string()),
      logo_allowed: z.boolean(),
    }),
    composition_strategy: z.object({
      layout: z.string(),
      focal_point: z.string(),
      scale_guidance: z.string(),
      background_treatment: z.string(),
      edge_behavior: z.string(),
    }),
    continuity_strategy: z.object({
      mode: z.enum(["single_surface", "panel_aware", "wrap", "repeat_pattern", "none"]),
      seam_strategy: z.enum(["none", "motif_continuation", "edge_blend", "repeat_alignment"]),
      repeat_strategy: z.enum(["none", "subtle_texture_repeat", "full_pattern_repeat"]),
      overlay_strategy: z.enum(["none", "blend_overlay_with_base", "separate_detail"]),
    }),
    placement_strategy: z.object({
      primary_placement: z.string(),
      placement_role: z.string(),
      additional_placements_requested: z.array(z.string()),
      additional_placements_allowed: z.boolean(),
      full_product_coverage_required: z.boolean(),
    }),
    negative_constraints: z.array(z.string()),
    ip_safety_constraints: z.array(z.string()),
    artwork_brief: z.string(),
    technical_notes: z.array(z.string()),
  }),
  master_design_ir_json: z.string(),
  design_program_text: z.string(),
  next_node: z.enum(["Save Design Program State"]),
  errors: z.array(z.string()),
});

export const ProductSurfacePlannerSchema = z.object({
  run_id: z.string(),
  surface_plan: z.object({
    product_id: z.any(),
    variant_id: z.any(),
    coverage_policy: CoveragePolicySchema,
    primary_mockup_goal: z.enum(["single_view", "multi_view", "full_product_preview", "unknown"]),
    supported_placements: z.array(
      z.object({
        placement: z.string(),
        technique: z.string(),
        supported: z.boolean(),
        source: z.string(),
        notes: z.string(),
      })
    ),
    required_placements: z.array(
      z.object({
        placement: z.string(),
        reason: z.enum([
          "required_by_product",
          "required_by_mockup_rules",
          "required_by_full_coverage_policy",
          "required_by_customer_request",
          "required_by_design_continuity",
        ]),
      })
    ),
    optional_placements: z.array(
      z.object({
        placement: z.string(),
        include_in_full_coverage: z.boolean(),
        reason: z.string(),
      })
    ),
    placement_jobs: z.array(PlacementJobSchema),
    surface_validation: z.object({
      surface_graph_checked: z.boolean(),
      template_geometry_checked: z.boolean(),
      mockup_payload_rules_checked: z.boolean(),
      design_ir_validation_checked: z.boolean(),
      tool_sources: z.array(
        z.enum([
          "get_surface_graph",
          "get_template_geometry",
          "get_mockup_payload_rules",
          "validate_design_ir_against_product",
        ])
      ),
    }),
  }),
  surface_plan_json: z.string(),
  surface_plan_text: z.string(),
  truth_gates: z.object({
    supported_placements_discovered: z.boolean(),
    required_placements_identified: z.boolean(),
    all_required_placements_planned: z.boolean(),
    geometry_available_or_not_required_for_all_jobs: z.boolean(),
    mockup_payload_rules_available: z.boolean(),
    design_ir_valid: z.boolean(),
    can_continue: z.boolean(),
  }),
  next_node: z.enum(["Save Surface Plan State"]),
  errors: z.array(z.string()),
});

export const ProductOptionsResolverSchema = z.object({
  run_id: z.string(),
  required_product_options: z.array(
    z.object({
      name: z.string(),
      required: z.boolean(),
      valid_values: z.array(z.string()),
      source: z.string(),
      notes: z.string(),
    })
  ),
  selected_product_options: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      selection_reason: z.string(),
      valid_value: z.boolean(),
    })
  ),
  product_options_json: z.string(),
  product_options_text: z.string(),
  stitch_color: z.enum(["black", "white", "not_required", "unresolved"]),
  truth_gates: z.object({
    mockup_payload_rules_checked: z.boolean(),
    required_options_detected: z.boolean(),
    all_required_options_resolved: z.boolean(),
    stitch_color_required: z.boolean(),
    stitch_color_valid: z.boolean(),
    can_continue: z.boolean(),
  }),
  next_node: z.enum(["Save Product Options State"]),
  errors: z.array(z.string()),
});

export const TechnicalQaAgentSchema = z.object({
  run_id: z.string(),
  technical_qa: z.object({
    pass: z.boolean(),
    checks: z.array(
      z.object({
        check: z.string(),
        status: z.enum(["pass", "fail", "warning"]),
        details: z.string(),
      })
    ),
    placement_qa: z.object({
      required_placements: z.array(z.string()),
      planned_placements: z.array(z.string()),
      missing_required_placements: z.array(z.string()),
      unsupported_planned_placements: z.array(z.string()),
      full_coverage_confirmed: z.boolean(),
    }),
    allowed_placement_jobs: z.array(z.string()),
    blocked_placement_jobs: z.array(
      z.object({
        job_id: z.string(),
        reason: z.string(),
      })
    ),
    tool_sources: z.array(
      z.enum([
        "validate_design_ir_against_product",
        "get_template_geometry",
        "get_mockup_payload_rules",
      ])
    ),
  }),
  technical_qa_text: z.string(),
  technical_qa_pass: z.boolean(),
  next_node: z.enum(["Save Technical QA State"]),
  errors: z.array(z.string()),
});

export const PlacementBundleCompilerSchema = z.object({
  run_id: z.string(),
  placement_bundle: z.object({
    product_id: z.any(),
    variant_id: z.any(),
    source_mode: z.enum([
      "multi_generated",
      "master_generated_then_sliced",
      "pattern_expanded",
      "hybrid",
      "no_art_required",
    ]),
    master_artwork_url: z.string().nullable(),
    placements: z.array(
      z.object({
        job_id: z.string(),
        placement: z.string(),
        file_url: z.string().nullable(),
        file_type: z.enum(["png", "none"]),
        public_url: z.boolean(),
        generation_mode: z.enum([
          "generated",
          "sliced",
          "derived",
          "repeated",
          "mirrored",
          "blank",
        ]),
        source_job_id: z.string().nullable(),
        source_parent_url: z.string().nullable(),
        geometry_applied: z.boolean(),
        transparent_background: z.boolean(),
        must_render_in_mockup: z.boolean(),
        status: z.enum(["success", "blank", "failed", "skipped_optional"]),
        notes: z.string(),
      })
    ),
    submitted_placement_files: z.array(
      z.object({
        placement: z.string(),
        file_url: z.string(),
      })
    ),
    missing_required_placements: z.array(
      z.object({
        placement: z.string(),
        reason: z.string(),
      })
    ),
  }),
  placement_bundle_json: z.string(),
  placement_bundle_text: z.string(),
  bundle_truth_gates: z.object({
    all_required_jobs_accounted_for: z.boolean(),
    all_required_generated_files_present: z.boolean(),
    all_public_urls_present: z.boolean(),
    all_geometry_requirements_applied: z.boolean(),
    submitted_files_match_renderable_jobs: z.boolean(),
    can_continue: z.boolean(),
  }),
  generation_status: z.enum(["success", "partial", "failed"]),
  next_node: z.enum(["Save Placement Bundle State"]),
  errors: z.array(z.string()),
});

export const MockupRenderAgentSchema = z.object({
  run_id: z.string(),
  mockup_result: z.object({
    ok: z.boolean(),
    provider: z.enum(["printful", "unknown"]),
    product_id: z.any(),
    variant_ids: z.array(z.any()),
    mockup_style_ids: z.array(z.any()),
    expected_placement_files: z.array(
      z.object({
        placement: z.string(),
        required: z.boolean(),
      })
    ),
    submitted_placement_files: z.array(
      z.object({
        placement: z.string(),
        file_url: z.string(),
      })
    ),
    product_options_submitted: z.array(
      z.object({
        name: z.string(),
        value: z.string(),
      })
    ),
    mockup_urls: z.array(z.string()),
    raw_task_status: z.enum([
      "completed",
      "failed",
      "pending",
      "timeout",
      "rate_limited",
      "invalid_request",
      "tool_error",
      "unknown",
    ]),
    source_truth_status: z.enum([
      "printful_mockup_task_backed",
      "failed",
      "rate_limited",
      "invalid_request",
      "unknown",
    ]),
    retryable: z.boolean(),
    retry_after_seconds: z.any(),
    repair_attempted: z.boolean(),
    attempt_count: z.any(),
    provider_error: z.object({
      code: z.string(),
      message: z.string(),
    }),
    next_action: z.enum([
      "none",
      "retry_mockup_task",
      "fix_request",
      "regenerate_missing_placements",
      "manual_review",
    ]),
  }),
  mockup_result_text: z.string(),
  mockup_url: z.string(),
  mockup_status: z.enum([
    "completed",
    "failed",
    "timeout",
    "rate_limited",
    "invalid_request",
    "tool_error",
    "unknown",
  ]),
  retryable: z.boolean(),
  retry_after_seconds: z.any(),
  next_action: z.enum([
    "none",
    "retry_mockup_task",
    "fix_request",
    "regenerate_missing_placements",
    "manual_review",
  ]),
  next_node: z.enum(["Save Mockup State"]),
  errors: z.array(z.string()),
});

export const FinalResponseComposerSchema = z.object({
  run_id: z.string(),
  status: z.enum(["success", "failed", "needs_revision", "needs_retry", "needs_user_approval"]),
  user_message: z.string(),
  mockup_urls: z.array(z.string()),
  design_summary: z.string(),
  placement_bundle_summary: z.string(),
  approval_required: z.boolean(),
  retry_after_seconds: z.any(),
  next_action: z.enum([
    "none",
    "retry_mockup_task",
    "revise_design_request",
    "regenerate_missing_placements",
    "manual_review",
  ]),
  internal_trace: z.object({
    product_truth: z.enum(["verified", "failed", "partial"]),
    pricing_truth: z.enum(["verified", "pending", "failed", "not_required"]),
    artwork_truth: z.enum(["verified", "failed", "partial"]),
    placement_bundle_truth: z.enum(["verified", "failed", "partial"]),
    mockup_truth: z.enum(["verified", "failed", "rate_limited", "invalid_request", "partial"]),
  }),
});
