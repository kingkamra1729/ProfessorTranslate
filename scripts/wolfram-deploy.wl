(* ==========================================================================
   Suvidha - Wolfram Cloud API deployment
   ==========================================================================

   Deploys the endpoint that renders lecture diagrams.

   Suvidha can fall back to the Wolfram|Alpha Simple API, which needs only an
   app ID, but that route takes a natural-language query and gives back
   whatever Alpha decides to show. This endpoint takes a Wolfram Language
   expression instead, which means the drafting model can ask for exactly the
   graphic the lecture needs - a VectorPlot with the right domain, a Plot3D from
   the right viewpoint, a StreamPlot of the actual field under discussion.

   HOW TO RUN
   ----------
   1. Open Wolfram Cloud (https://www.wolframcloud.com) or a local Mathematica
      notebook signed in to your Wolfram|One account.
   2. Paste this whole file into a notebook and evaluate it.
   3. Copy the URL it prints into your .env as WOLFRAM_CLOUD_API_URL.

   Calls against a deployed API consume Cloud Credits from your Wolfram|One
   allowance, so the server only calls this once a professor has approved a
   diagram - never on a suggestion the professor has not looked at.
   ========================================================================== *)

(* --------------------------------------------------------------------------
   Safety.

   The `expr` parameter arrives as a string built by a language model, and is
   evaluated. Restricting it to a known set of graphics heads means a
   malformed - or adversarial - expression cannot reach DeleteFile, Import,
   URLFetch or anything else with an effect beyond drawing a picture.
   -------------------------------------------------------------------------- *)

$SuvidhaAllowedHeads = {
  "Plot", "Plot3D", "ListPlot", "ListLinePlot", "ParametricPlot",
  "ParametricPlot3D", "PolarPlot", "ContourPlot", "ContourPlot3D",
  "DensityPlot", "RegionPlot", "VectorPlot", "VectorPlot3D", "StreamPlot",
  "ComplexPlot", "ComplexPlot3D", "LogPlot", "LogLogPlot", "LogLinearPlot",
  "BarChart", "Histogram", "PieChart", "NumberLinePlot", "ArrayPlot",
  "MatrixPlot", "Graphics", "Graphics3D", "Show", "GraphicsRow",
  "GraphicsGrid", "Legended", "Labeled"
};

SuvidhaSafeQ[exprString_String] := Module[{held, head},
  held = Quiet@ToExpression[exprString, InputForm, Hold];
  If[held === $Failed || held === Hold[], Return[False]];
  head = Quiet@ToString[Head[ReleaseHold[Hold @@ {Extract[held, {1, 0}, Hold]}]]];
  head = Quiet@ToString@Extract[held, {1, 0}];
  MemberQ[$SuvidhaAllowedHeads, head]
];

(* --------------------------------------------------------------------------
   Rendering.

   The styling is chosen for a projector and a phone at the back of a hall:
   thick strokes, large labels, and a light background so the image stays
   readable if a student screenshots it into a document.
   -------------------------------------------------------------------------- *)

SuvidhaRender[exprString_String, w_Integer, h_Integer] := Module[{expr, graphic},
  If[! SuvidhaSafeQ[exprString],
    Return@Rasterize[
      Style["This expression is not an allowed graphic.", 16, Red],
      ImageSize -> {w, 80}
    ]
  ];

  expr = Quiet@ToExpression[exprString];

  graphic = Quiet@Show[
    expr,
    ImageSize -> {w, h},
    Background -> RGBColor[0.969, 0.969, 0.973],
    BaseStyle -> {FontFamily -> "Helvetica", FontSize -> 15},
    LabelStyle -> {FontSize -> 16, Black},
    PlotRangePadding -> Scaled[0.04]
  ];

  If[Head[graphic] === Show || graphic === $Failed,
    (* `Show` did not resolve, so the expression was not a graphic after all. *)
    Rasterize[Style["Could not render this expression.", 16, Gray], ImageSize -> {w, 80}],
    Rasterize[graphic, "Image", ImageResolution -> 144]
  ]
];

(* --------------------------------------------------------------------------
   Deployment.
   -------------------------------------------------------------------------- *)

$SuvidhaAPI = CloudDeploy[
  APIFunction[
    {
      "expr"   -> "String",
      "width"  -> "Integer" -> 900,
      "height" -> "Integer" -> 560
    },
    SuvidhaRender[#expr, #width, #height] &,
    "PNG"
  ],
  "suvidha/render",
  Permissions -> "Public"
];

Print["\n  Suvidha render endpoint deployed."];
Print["  Add this line to your .env:\n"];
Print["  WOLFRAM_CLOUD_API_URL=", First[$SuvidhaAPI]];
Print["\n  Test it in a browser:"];
Print["  ", First[$SuvidhaAPI], "?expr=", URLEncode["Plot[Sin[x]/x, {x, -20, 20}]"], "\n"];
