/*
 * Minimal browser-facing wrapper around RNAlib's global MFE API.
 *
 * The binding exposes global single-sequence MFE folding, hard-pair constrained
 * folding, and the two-strand RNAcofold operation used to derive HYB-guided
 * evidence.  Keeping these operations narrow makes their memory boundary
 * auditable from the Web Worker.
 */

#include <math.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include <ViennaRNA/fold_compound.h>
#include <ViennaRNA/constraints/hard.h>
#include <ViennaRNA/mfe/global.h>
#include <ViennaRNA/model.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define RNAXRAY_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define RNAXRAY_EXPORT
#endif

#ifndef RNAXRAY_VIENNA_VERSION
#define RNAXRAY_VIENNA_VERSION "unknown"
#endif

static int
valid_rna_sequence(const char *sequence)
{
  const char *cursor;

  if ((!sequence) || (!sequence[0]))
    return 0;

  for (cursor = sequence; *cursor; cursor++) {
    switch (*cursor) {
      case 'A':
      case 'C':
      case 'G':
      case 'U':
        break;
      default:
        return 0;
    }
  }

  return 1;
}

static int
canonical_pair(char left,
               char right)
{
  return (((left == 'A') && (right == 'U')) ||
          ((left == 'U') && ((right == 'A') || (right == 'G'))) ||
          ((left == 'C') && (right == 'G')) ||
          ((left == 'G') && ((right == 'C') || (right == 'U'))));
}

static int
valid_constraint_pairs(const char         *sequence,
                       size_t             length,
                       int                minimum_loop,
                       const unsigned int *constraint_pairs,
                       size_t             constraint_count)
{
  size_t first;

  if (constraint_count == 0)
    return 1;

  if ((!constraint_pairs) || (constraint_count > length / 2))
    return 0;

  for (first = 0; first < constraint_count; first++) {
    const unsigned int i = constraint_pairs[first * 2];
    const unsigned int j = constraint_pairs[first * 2 + 1];
    size_t second;

    if ((i == 0) || (j <= i) || (j > length) ||
        ((j - i - 1) < (unsigned int)minimum_loop) ||
        (!canonical_pair(sequence[i - 1], sequence[j - 1])))
      return 0;

    for (second = 0; second < first; second++) {
      const unsigned int k = constraint_pairs[second * 2];
      const unsigned int l = constraint_pairs[second * 2 + 1];

      if ((i == k) || (i == l) || (j == k) || (j == l))
        return 0;

      /* Dot-bracket output cannot represent crossing (pseudoknotted) pairs. */
      if (((i < k) && (k < j) && (j < l)) ||
          ((k < i) && (i < l) && (l < j)))
        return 0;
    }
  }

  return 1;
}

static int
constraints_are_present(const char         *structure,
                        size_t             length,
                        const unsigned int *constraint_pairs,
                        size_t             constraint_count)
{
  unsigned int *partners;
  unsigned int *stack;
  size_t depth = 0;
  size_t position;
  size_t constraint;
  int valid = 1;

  if (constraint_count == 0)
    return 1;

  partners = calloc(length + 1, sizeof(unsigned int));
  stack = calloc(length, sizeof(unsigned int));
  if ((!partners) || (!stack)) {
    free(stack);
    free(partners);
    return 0;
  }

  for (position = 0; position < length; position++) {
    if (structure[position] == '(') {
      stack[depth++] = (unsigned int)position + 1;
    } else if (structure[position] == ')') {
      unsigned int left;

      if (depth == 0) {
        valid = 0;
        break;
      }
      left = stack[--depth];
      partners[left] = (unsigned int)position + 1;
      partners[position + 1] = left;
    } else if (structure[position] != '.') {
      valid = 0;
      break;
    }
  }

  if (depth != 0)
    valid = 0;

  for (constraint = 0; valid && (constraint < constraint_count); constraint++) {
    const unsigned int i = constraint_pairs[constraint * 2];
    const unsigned int j = constraint_pairs[constraint * 2 + 1];
    if (partners[i] != j)
      valid = 0;
  }

  free(stack);
  free(partners);
  return valid;
}

static double
fold_mfe(const char         *sequence,
         double             temperature,
         int                minimum_loop,
         const unsigned int *constraint_pairs,
         size_t             constraint_count,
         char               *structure_out,
         size_t             structure_out_bytes)
{
  const size_t length = sequence ? strlen(sequence) : 0;
  char *structure = NULL;
  float mfe = NAN;
  vrna_md_t md;
  vrna_fold_compound_t *fc = NULL;
  size_t constraint;

  if ((!valid_rna_sequence(sequence)) || (!structure_out) ||
      (structure_out_bytes < length + 1) || (!isfinite(temperature)) ||
      (temperature < -273.15) || (temperature > 100.) ||
      (minimum_loop < 0) || (minimum_loop > 30) ||
      (!valid_constraint_pairs(sequence,
                               length,
                               minimum_loop,
                               constraint_pairs,
                               constraint_count)))
    return NAN;

  vrna_md_set_default(&md);
  md.temperature = temperature;
  md.min_loop_size = minimum_loop;

  fc = vrna_fold_compound(sequence, &md, VRNA_OPTION_MFE);
  if (!fc)
    return NAN;

  for (constraint = 0; constraint < constraint_count; constraint++) {
    const unsigned int i = constraint_pairs[constraint * 2];
    const unsigned int j = constraint_pairs[constraint * 2 + 1];
    const unsigned char options = (unsigned char)(VRNA_CONSTRAINT_CONTEXT_ALL_LOOPS |
                                                   VRNA_CONSTRAINT_CONTEXT_ENFORCE);

    if (!vrna_hc_add_bp(fc, i, j, options)) {
      vrna_fold_compound_free(fc);
      return NAN;
    }
  }

  structure = calloc(length + 1, sizeof(char));
  if (!structure) {
    vrna_fold_compound_free(fc);
    return NAN;
  }

  mfe = vrna_mfe(fc, structure);
  if (isfinite(mfe) &&
      constraints_are_present(structure, length, constraint_pairs, constraint_count))
    memcpy(structure_out, structure, length + 1);
  else
    mfe = NAN;

  free(structure);
  vrna_fold_compound_free(fc);

  return isfinite(mfe) ? (double)mfe : NAN;
}

/*
 * Return the MFE in kcal/mol and write its dot-bracket structure into the
 * caller-owned output buffer.  NaN signals invalid input or an RNAlib failure.
 */
RNAXRAY_EXPORT
double
rnaxray_vienna_mfe(const char *sequence,
                double     temperature,
                int        minimum_loop,
                char       *structure_out,
                size_t     structure_out_bytes)
{
  return fold_mfe(sequence,
                  temperature,
                  minimum_loop,
                  NULL,
                  0,
                  structure_out,
                  structure_out_bytes);
}

/*
 * Fold with zero or more enforced, 1-based, non-crossing base pairs.  The
 * flattened constraint_pairs buffer contains [i0, j0, i1, j1, ...].
 */
RNAXRAY_EXPORT
double
rnaxray_vienna_mfe_constrained(const char         *sequence,
                            double             temperature,
                            int                minimum_loop,
                            const unsigned int *constraint_pairs,
                            size_t             constraint_count,
                            char               *structure_out,
                            size_t             structure_out_bytes)
{
  return fold_mfe(sequence,
                  temperature,
                  minimum_loop,
                  constraint_pairs,
                  constraint_count,
                  structure_out,
                  structure_out_bytes);
}

RNAXRAY_EXPORT
const char *
rnaxray_vienna_version(void)
{
  return RNAXRAY_VIENNA_VERSION;
}

/*
 * Reproduce the MFE stage of `RNAcofold --noconv --noPS` for two RNA arms.
 * RNAlib accepts the two strands separated by '&', while the returned
 * dot-bracket omits the separator and therefore has length len(A) + len(B).
 */
RNAXRAY_EXPORT
double
rnaxray_vienna_cofold(const char *sequence_one,
                   const char *sequence_two,
                   double     temperature,
                   int        minimum_loop,
                   char       *structure_out,
                   size_t     structure_out_bytes)
{
  const size_t length_one = sequence_one ? strlen(sequence_one) : 0;
  const size_t length_two = sequence_two ? strlen(sequence_two) : 0;
  const size_t length = length_one + length_two;
  char *complex_sequence = NULL;
  char *structure = NULL;
  float mfe = NAN;
  vrna_md_t md;
  vrna_fold_compound_t *fc = NULL;

  if ((!valid_rna_sequence(sequence_one)) ||
      (!valid_rna_sequence(sequence_two)) ||
      (length < length_one) ||
      (!structure_out) ||
      (structure_out_bytes < length + 1) ||
      (!isfinite(temperature)) ||
      (temperature < -273.15) ||
      (temperature > 100.) ||
      (minimum_loop < 0) ||
      (minimum_loop > 30))
    return NAN;

  complex_sequence = calloc(length + 2, sizeof(char));
  structure = calloc(length + 1, sizeof(char));
  if ((!complex_sequence) || (!structure)) {
    free(structure);
    free(complex_sequence);
    return NAN;
  }

  memcpy(complex_sequence, sequence_one, length_one);
  complex_sequence[length_one] = '&';
  memcpy(complex_sequence + length_one + 1, sequence_two, length_two + 1);

  vrna_md_set_default(&md);
  md.temperature = temperature;
  md.min_loop_size = minimum_loop;
  fc = vrna_fold_compound(complex_sequence,
                          &md,
                          VRNA_OPTION_DEFAULT | VRNA_OPTION_HYBRID);
  if (fc)
    mfe = vrna_mfe_dimer(fc, structure);

  if (fc && isfinite(mfe) && (strlen(structure) == length))
    memcpy(structure_out, structure, length + 1);
  else
    mfe = NAN;

  if (fc)
    vrna_fold_compound_free(fc);
  free(structure);
  free(complex_sequence);

  return isfinite(mfe) ? (double)mfe : NAN;
}
