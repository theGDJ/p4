import type { Intent, Language } from '../constants';
import { namesStandard, uwords, ustart } from './regex';

/**
 * Language detection and intent routing (§5, query path step 1).
 *
 * Both are deliberately deterministic and rule-based in P1: routing decides
 * whether to spend tokens on retrieval at all (§9 "route first"), so a wrong
 * route is a cost bug, not just a quality bug. A small model replaces the
 * keyword table in P2 behind the same function signature.
 *
 * All keyword patterns are compiled through `uwords()`/`ustart()` from `./regex`,
 * never with `\b`, because `\b` is ASCII-only and would silently disable every
 * Hindi rule.
 */

/* --------------------------------------------------------- language detection */

/** Romanised-Hindi cues: Latin script, Hindi grammar. Common on mobile keyboards. */
const ROMANISED_HI = uwords(
  'kya|kaise|kaun|kaunsa|kaunsi|hai|hain|bataiye|batao|chahiye|mera|meri|ham|aap|nahi|nahin|karein|karna|hoti|prapt|anumati|manak|kitna|kab|kahan',
);

/**
 * Detects the dominant language. Devanagari script is decisive for Hindi;
 * otherwise romanised-Hindi cues are checked before defaulting to English.
 */
export function detectLanguage(text: string): Language {
  const sample = text.slice(0, 500);
  const devanagari = (sample.match(/[\u0900-\u097F]/g) ?? []).length;
  if (devanagari >= 3) return 'hi';

  const letters = (sample.match(/\p{L}/gu) ?? []).length || 1;
  if (devanagari / letters > 0.2) return 'hi';

  if (ROMANISED_HI.test(sample)) return 'hi';

  return 'en';
}

/** True when the text contains any Devanagari; used to pick the answer script. */
export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/u.test(text);
}

/* ------------------------------------------------------------------ intents */

/** Domain vocabulary. Presence says the topic is BIS-related, NOT that the product is known. */
const FACTUAL_HINTS = uwords(
  'standard|standards|specification|clause|bis|qco|quality control order|fee|fees|timeline|eligib\\w*|procedure|requirement|requirements|manak|मानक|मानकों|धारा|शुल्क|पात्रता|प्रक्रिया|आवश्यकता|प्रमाणन|हॉलमार्क',
);

/**
 * Concrete product / material / use signals. Presence of one of these means the
 * question has a retrievable subject; absence means we must ask (feature #8).
 *
 * Deliberately NOT satisfied by domain vocabulary such as "standard", "BIS",
 * "certification" or "quality" — knowing the asker means BIS tells us nothing
 * about *what* they are making, which is exactly the gap the clarifier closes.
 * An earlier version treated those words as sufficient and let "standard chahiye"
 * through to retrieval, producing a bare R4 fallback instead of three questions.
 */
const PRODUCT_SIGNALS = uwords(
  [
    // English — materials, products, goods
    'water', 'drinking', 'cement', 'concrete', 'steel', 'iron', 'aluminium', 'aluminum', 'copper',
    'milk', 'dairy', 'gold', 'silver', 'platinum', 'jewellery', 'jewelry', 'ornament', 'bangle', 'ring',
    'toy', 'toys', 'cable', 'cables', 'wire', 'cord', 'plug', 'socket', 'switch', 'helmet', 'tyre', 'tire',
    'gas', 'cylinder', 'lpg', 'pressure', 'cooker', 'stove', 'refrigerator', 'air[- ]condition\\w*', 'fan',
    'lamp', 'bulb', 'led', 'light', 'paint', 'varnish', 'lacquer', 'paper', 'rubber', 'plastic', 'polymer',
    'pvc', 'textile', 'textiles', 'garment', 'fabric', 'yarn', 'food', 'spice', 'spices', 'edible', 'oil',
    'ghee', 'butter', 'paneer', 'honey', 'tea', 'coffee', 'rice', 'wheat', 'flour', 'atta', 'biscuit',
    'battery', 'solar', 'photovoltaic', 'pipe', 'pipes', 'tube', 'valve', 'nut', 'bolt', 'screw', 'bearing',
    'transformer', 'motor', 'appliance', 'appliances', 'furniture', 'footwear', 'leather', 'chemical',
    'chemicals', 'fertilizer', 'fertiliser', 'pesticide', 'seed', 'seeds', 'bottle', 'bottles', 'jar',
    'packaging', 'glass', 'ceramic', 'brick', 'bricks', 'plywood', 'vanaspati', 'namkeen', 'noodles',
    'rod', 'rods', 'sheet', 'sheets', 'powder', 'granules', 'tablet', 'syrup',
    // Hindi — the same subjects in Devanagari
    'पानी', 'जल', 'सीमेंट', 'इस्पात', 'लोहा', 'एल्युमिनियम', 'तांबा', 'दूध', 'सोना', 'चांदी',
    'आभूषण', 'गहना', 'गहने', 'चूड़ी', 'अंगूठी', 'खिलौना', 'खिलौने', 'केबल', 'तार', 'प्लग', 'स्विच',
    'हेलमेट', 'टायर', 'गैस', 'सिलेंडर', 'कुकर', 'चूल्हा', 'फ्रिज', 'पंखा', 'बल्ब', 'दीपक', 'रंग',
    'वार्निश', 'कागज', 'रबर', 'प्लास्टिक', 'कपड़ा', 'वस्त्र', 'खाद्य', 'मसाला', 'तेल', 'घी', 'मक्खन',
    'पनीर', 'शहद', 'चाय', 'कॉफी', 'चावल', 'गेहूं', 'आटा', 'बिस्कुट', 'बैटरी', 'सौर', 'पाइप', 'वाल्व',
    'नट', 'बोल्ट', 'पेंच', 'ट्रांसफॉर्मर', 'मोटर', 'उपकरण', 'फर्नीचर', 'जूता', 'जूते', 'चमड़ा',
    'रासायन', 'उर्वरक', 'कीटनाशक', 'बीज', 'बोतल', 'पैकेजिंग', 'कांच', 'सिरामिक', 'ईंट', 'प्लाईवुड',
    'छड़', 'शीट', 'चूर्ण', 'गोलियां',
  ].join('|'),
);

interface IntentRule {
  intent: Intent;
  /** A match on any pattern routes to this intent. */
  patterns: RegExp[];
}

/** Ordered: first match wins. Specific intents precede the vague/factual fallback. */
const RULES: IntentRule[] = [
  {
    intent: 'chitchat',
    patterns: [
      // Fully anchored, so no word boundary is needed — and none is safe here,
      // because a trailing `\b` would break the Devanagari greetings.
      /^(hi|hello|hey|namaste|नमस्ते|नमस्कार|हैलो|good (morning|evening|afternoon)|thanks|thank you|धन्यवाद|shukriya|bye|ok|okay|theek hai)[\s!.?।]*$/iu,
      /^(how are you|kaise ho|आप कैसे हैं|कैसे हो)[\s?!।]*$/iu,
    ],
  },
  {
    intent: 'meta',
    patterns: [
      uwords('who are you|what are you|what can you do|how do you work|about you|about this app|तुम कौन|आप कौन|यह ऐप क्या|यह टूल क्या|क्या कर सकते'),
      uwords('bis[- ]saathi|this assistant|your sources|do you certify|are you official|आपके स्रोत'),
    ],
  },
  {
    intent: 'hallmarking',
    patterns: [
      uwords(
        'hallmark|hallmarking|huid|916|22 ?carat|18 ?carat|purity|jewellery|jewelry|gold|silver|आभूषण|सोना|चांदी|हॉलमार्क|शुद्धता|पैतृक',
      ),
    ],
  },
  {
    intent: 'certification',
    patterns: [
      uwords(
        'certify|certification|certified|licence|license|licensing|isi ?mark|apply|application|crs|registration|eco ?mark|scheme|प्रमाणन|प्रमाणपत्र|लाइसेंस|पंजीकरण|आवेदन|आईएसआई|अनुमति',
      ),
    ],
  },
  {
    intent: 'lab',
    patterns: [
      uwords('lab|labs|laboratory|laboratories|nabl|accredited|परीक्षण प्रयोगशाला|प्रयोगशाला|लैब'),
    ],
  },
  {
    intent: 'recommend',
    patterns: [
      // English: "which standard applies to ...", "what specification is required ..."
      ustart('(which|what|whichever)\\s+(\\w+\\s+){0,4}(standard|specification)s?\\s+(\\w+\\s+){0,3}(applies|apply|applys|needed|required|should|covers|is)'),
      uwords('recommend|recommendation|suggestion|suitable|applicable standard|सुझाव|सलाह|सिफारिश'),
      // Hindi: allows an intervening word, e.g. "कौन सा भारतीय मानक" — the earlier
      // pattern required "कौन सा मानक" contiguously and missed the common phrasing.
      ustart('कौन\\s?सा\\s+(?:भारतीय\\s+)?(?:मानक|स्टैंडर्ड)'),
      ustart('कौन\\s?से\\s+(?:भारतीय\\s+)?(?:मानक|स्टैंडर्ड)'),
    ],
  },
];

/**
 * Vague input lacks the product/material/use/consumer-vs-industrial signals the
 * clarification engine needs (§6 #8). Detecting it here is what lets us ask ≤3
 * focused questions instead of guessing.
 *
 * Note: `route()` applies the intent rules BEFORE this check, so a named service
 * topic that needs no product ("BIS certification", "hallmarking") still routes to
 * its own intent even though `isVague()` is true for it. That is intentional — a
 * certification procedure is answerable from a guide without knowing the product.
 */
export function isVague(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // Naming a standard IS the concrete subject: "What is the carbon limit in
  // IS 10500?" is 8 words and completely answerable. Treating a short, specific
  // question as vague is how an assistant ends up interrogating the user about a
  // question they had already finished asking.
  if (namesStandard(t)) return false;
  // A concrete subject means we have something to retrieve on.
  if (PRODUCT_SIGNALS.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  // Short and subject-less: ask rather than guess.
  if (words.length <= 6) return true;
  // Long but still no identifiable product/material/use.
  return t.length < 60;
}

export interface RouteDecision {
  language: Language;
  intent: Intent;
  /** True when the caller should be asked to clarify rather than answered. */
  clarify: boolean;
  /** Whether retrieval should run at all (§9: chitchat/meta skip it). */
  retrieve: boolean;
  reason: string;
}

export function route(text: string, hintLanguage?: Language): RouteDecision {
  const trimmed = text.trim();
  const language = hintLanguage ?? detectLanguage(trimmed);

  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) {
        const skipRetrieval = rule.intent === 'chitchat' || rule.intent === 'meta';
        return {
          language,
          intent: rule.intent,
          clarify: false,
          retrieve: !skipRetrieval,
          reason: `matched ${rule.intent} pattern`,
        };
      }
    }
  }

  if (isVague(trimmed)) {
    return {
      language,
      intent: 'clarify',
      clarify: true,
      retrieve: false,
      reason: 'insufficient product/material/use detail to retrieve on',
    };
  }

  return {
    language,
    intent: 'factual',
    clarify: false,
    retrieve: true,
    reason: FACTUAL_HINTS.test(trimmed) ? 'domain terms present' : 'default factual route',
  };
}

/**
 * Follow-up chips (§6 #2). Generated locally in P1 from the routed intent; in P2
 * the small model proposes them and they are validated the same way as citations.
 */
export function suggestFollowUps(intent: Intent, language: Language): string[] {
  const en: Record<string, string[]> = {
    hallmarking: [
      'What does the BIS hallmark on gold jewellery indicate?',
      'How do I verify a hallmark on an item I own?',
      'Which standards apply to hallmarking of gold?',
    ],
    certification: [
      'What are the steps to apply for a BIS licence?',
      'Which documents are needed for certification?',
      'Is my product under a Quality Control Order?',
    ],
    lab: ['Which BIS-recognised laboratories test this product?', 'What tests does the standard require?'],
    recommend: ['Which standard applies to my product?', 'Are there related standards I should check?'],
    clarify: ['What product details do you need?', 'Can you give an example question?'],
    factual: [
      'Which Indian Standard applies to my product?',
      'How does BIS certification work?',
      'How do I check a hallmark?',
    ],
  };
  const hi: Record<string, string[]> = {
    hallmarking: [
      'सोने के आभूषण पर BIS हॉलमार्क क्या दर्शाता है?',
      'मैं अपने आभूषण का हॉलमार्क कैसे जाँचूँ?',
      'हॉलमार्किंग के लिए कौन से मानक लागू होते हैं?',
    ],
    certification: [
      'BIS लाइसेंस के लिए आवेदन करने के चरण क्या हैं?',
      'प्रमाणन के लिए कौन से दस्तावेज़ आवश्यक हैं?',
      'क्या मेरा उत्पाद किसी गुणवत्ता नियंत्रण आदेश के अंतर्गत आता है?',
    ],
    lab: ['इस उत्पाद की जाँच कौन सी प्रयोगशालाएँ करती हैं?', 'मानक के अनुसार कौन से परीक्षण आवश्यक हैं?'],
    recommend: ['मेरे उत्पाद पर कौन सा मानक लागू होता है?', 'क्या कोई संबंधित मानक भी जाँचना चाहिए?'],
    clarify: ['आपको उत्पाद के कौन से विवरण चाहिए?', 'क्या आप एक उदाहरण प्रश्न दे सकते हैं?'],
    factual: [
      'मेरे उत्पाद पर कौन सा भारतीय मानक लागू होता है?',
      'BIS प्रमाणन कैसे काम करता है?',
      'हॉलमार्क कैसे जाँचें?',
    ],
  };
  const table = language === 'hi' ? hi : en;
  return (table[intent] ?? table.factual ?? []).slice(0, 3);
}
