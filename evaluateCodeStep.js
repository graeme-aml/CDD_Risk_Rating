async function evaluateCodeStep(args) {

  // --- Constants ---
  const TAG_SCORES = {
    "SOS FILING UNKNOWN":     20,
    "FEIN NO MATCH":          15,
    "BIZ NAME NO MATCH":      15,
    "BIZ ADDRESS NO MATCH":   10,
    "BRV AP MATCH NOT FOUND": 15,
  };
  const FORCE_HIGH_RISK = new Set([
    "UBO PEP CONFIRMED",
    "UBO ADVERSE MEDIA CONFIRMED",
    "FAILED BRV VERIFIED",
  ]);
  const PROHIBITED_OVERRIDES = new Set([
    "OFAC HIT",
    "OFAC CONFIRMED",
    "SANCTIONS MATCH",
    "WATCHLIST MATCH",
    "TF TYPOLOGY CONFIRMED",
  ]);
  const HIGH_RISK_COUNTRIES = new Set([
    "IR", "KP", "CU", "SY", "RU", "BY", "MM", "VE", "CN",
  ]);
  const ELEVATED_STATES = new Set([
    "CA", "CO", "OR", "WA", "NV", "MI", "IL",
  ]);

  // Matched against Nature of business field (case-insensitive phrase match).
  // Prohibited is checked before high-risk so that more specific phrases
  // (e.g. "escort agency") take precedence over shorter overlapping terms.
  const PROHIBITED_INDUSTRY = [
    "casino", "gambling establishment", "sportsbook", "wagering establishment",
    "lottery operator", "online casino", "online gambling platform",
    "racetrack", "horse racing", "dog racing",
    "adult entertainment", "pornographic content", "adult content",
    "escort agency", "escort club",
    "wealth management firm",
    "prepaid telecom", "prepaid phone card",
  ];

  const HIGH_RISK_INDUSTRY = [
    "travel agency", "tour operator",
    "money transfer", "money order",
    "precious metals", "gemstone", "jewelry dealer", "jeweler",
    "pharmaceutical", "pharma",
    "drug store", "pharmacy",
    "pawn shop", "pawnbroker",
    "telemarketing", "telemarketer",
    "art dealer", "auction house",
    "cultural artifact", "archaeological artifact",
    "tobacco retailer", "cigar store", "smoke shop",
    "firearms dealer", "gun shop", "ammunition dealer", "armory",
    "atm operator", "automated teller machine owner",
    "non-bank financial institution",
    "securities broker", "securities dealer", "stockbroker",
    "person-to-person payment", "p2p payment",
    "stored value card", "prepaid load",
    "dating agency",
    "massage parlor",
    "video rental",
    "charitable organization", "charities",
    "political organization", "political action committee", "political",
    "bail bond", "bail bondsman", "bail", "bond",
    "marijuana", "cannabis dispensary", "mrb",
    "crypto exchange", "cryptocurrency exchange", "virtual asset exchange", "nft marketplace", "crypto", "cryptocurrency",
  ];

  // --- Fetch Account via Case ---
  const caseId = args.property1;
  console.log("caseId received:", caseId);

  const persona = PersonaClient(env.PERSONA_API_KEY, { "Key-inflection": "snake" });

  const accountsList = await persona.accounts.list({ "filter[case_id]": caseId });
  console.log("accountsList:", JSON.stringify(accountsList));

  const account = accountsList && accountsList.data && accountsList.data[0];
  if (!account) throw new Error("No account found for case " + caseId);

  const tags    = account && account.attributes && account.attributes.tags || [];
  const state   = account && account.attributes && account.attributes.fields && account.attributes.fields.business_physical_address && account.attributes.fields.business_physical_address.value && account.attributes.fields.business_physical_address.value.subdivision && account.attributes.fields.business_physical_address.value.subdivision.value || "";
  const country = account && account.attributes && account.attributes.fields && account.attributes.fields.business_physical_address && account.attributes.fields.business_physical_address.value && account.attributes.fields.business_physical_address.value.country_code && account.attributes.fields.business_physical_address.value.country_code.value || "";

  // nature_of_business lives on the KYB transaction, not the account
  const transactionsList = await persona.transactions.list({ "filter[case_id]": caseId });
  console.log("transactionsList:", JSON.stringify(transactionsList));

  const kybTransaction = transactionsList && transactionsList.data && transactionsList.data.find(function(t) {
    return t.type && t.type.indexOf("kyb") !== -1;
  });
  console.log("kybTransaction type:", kybTransaction && kybTransaction.type);

  const natureOfBusiness = (kybTransaction && kybTransaction.attributes && kybTransaction.attributes.fields && kybTransaction.attributes.fields["nature of business"] && kybTransaction.attributes.fields["nature of business"].value || "").toLowerCase();
  console.log("natureOfBusiness:", natureOfBusiness);

  // --- Helper: case-insensitive phrase match, returns first matched term ---
  function matchesKeyword(text, keywords) {
    for (var k = 0; k < keywords.length; k++) {
      if (text.indexOf(keywords[k]) !== -1) return keywords[k];
    }
    return null;
  }

  // --- Prohibited check ---
  var prohibitedTag = null;
  for (var i = 0; i < tags.length; i++) {
    if (PROHIBITED_OVERRIDES.has(tags[i])) { prohibitedTag = tags[i]; break; }
  }
  if (prohibitedTag) {
    return {
      risk_score:      999,
      risk_tier:       "Prohibited",
      requires_review: true,
      triggered_by:    prohibitedTag,
    };
  }

  var prohibitedKeyword = matchesKeyword(natureOfBusiness, PROHIBITED_INDUSTRY);
  if (prohibitedKeyword) {
    return {
      risk_score:      999,
      risk_tier:       "Prohibited",
      requires_review: true,
      triggered_by:    "Industry: " + prohibitedKeyword,
    };
  }

  // --- Score calculation ---
  var score = 0;
  for (var entry of Object.entries(TAG_SCORES)) {
    if (tags.indexOf(entry[0]) !== -1) score += entry[1];
  }
  var countryUpper = country.toUpperCase();
  if (HIGH_RISK_COUNTRIES.has(countryUpper))        score += 40;
  else if (countryUpper !== "US" && country !== "") score += 15;
  if (ELEVATED_STATES.has(state.toUpperCase()))     score += 5;

  // --- Tier determination ---
  var risk_tier;
  var confirmedHighRisk = false;
  for (var j = 0; j < tags.length; j++) {
    if (FORCE_HIGH_RISK.has(tags[j])) { confirmedHighRisk = true; break; }
  }

  var highRiskIndustry = matchesKeyword(natureOfBusiness, HIGH_RISK_INDUSTRY);

  if (confirmedHighRisk || highRiskIndustry) {
    risk_tier = "High Risk";
  } else if (score >= 60) {
    risk_tier = "High Risk";
  } else if (score >= 30) {
    risk_tier = "Medium Risk";
  } else {
    risk_tier = "Low Risk";
  }

  // --- Return ---
  return {
    risk_score:      score,
    risk_tier:       risk_tier,
    requires_review: risk_tier === "High Risk",
    ...(highRiskIndustry && { triggered_by: "Industry: " + highRiskIndustry }),
  };
}
