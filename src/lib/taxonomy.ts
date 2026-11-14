// Fixed vocabularies shared by the content schema, filters and the quiz.
export const FAMILIES = ["amber", "woody", "floral", "citrus", "chypre", "fresh", "gourmand", "aromatic"] as const;
export const GENDERS = ["women", "men", "unisex"] as const;
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const OCCASIONS = ["day", "night", "office", "date"] as const;
export const SHAPES = ["classic", "tall", "round", "square"] as const;
export const SIZES = [2, 5, 10, 30] as const;

export type Family = (typeof FAMILIES)[number];
export type Gender = (typeof GENDERS)[number];
export type Season = (typeof SEASONS)[number];
export type Occasion = (typeof OCCASIONS)[number];
