"""Shared covariate interpretation for preliminary and completed-output reviews."""

MISSING_COVARIATES = {'', 'na', 'n/a', 'nan', 'unknown', 'not reported', '--'}
HANDLED_RACES = {'asian', 'black or african american', 'white', 'not reported',
                 'american indian or alaska native'}
SIGNET_RACES = {'asian', 'black or african american', 'white'}


def clinical_covariates(values, choices=None):
    """Interpret matched first-row covariates without changing any source record.

    Category labels in this private report are for the manual review only.
    Model reports must project approved counts, never copy these dictionaries.
    """
    choices = {} if choices is None else choices
    result = {'missing_gender': 0, 'missing_race': 0, 'source_missing_race': 0,
              'race': {}, 'gender': {}, 'unrecognized_race': {}, 'races_after': {},
              'retained': 0, 'excluded': 0}
    races, genders, unsupported = set(), set(), set()
    for race, gender in values:
        race, gender = race.strip(), gender.strip()
        label = race or '(blank)'
        result['race'][label] = result['race'].get(label, 0) + 1
        result['gender'][gender or '(blank)'] = result['gender'].get(gender or '(blank)', 0) + 1
        result['source_missing_race'] += race not in HANDLED_RACES and race.lower() in MISSING_COVARIATES
        if race not in HANDLED_RACES:
            result['unrecognized_race'][label] = result['unrecognized_race'].get(label, 0) + 1
            if label not in choices:
                unsupported.add(label)
                continue
            race = 'not reported' if choices[label] == 'not_reported' else 'american indian or alaska native'
        if race == 'american indian or alaska native':
            result['excluded'] += 1
            continue
        if race == 'not reported':
            race = 'white'
        if race.lower() in MISSING_COVARIATES:
            result['missing_race'] += 1
        elif race not in SIGNET_RACES:
            unsupported.add(race)
        else:
            races.add(race)
            result['races_after'][race] = result['races_after'].get(race, 0) + 1
        result['retained'] += 1
        if gender.lower() in MISSING_COVARIATES:
            result['missing_gender'] += 1
        else:
            genders.add(gender)
    result.update(unsupported_races=sorted(unsupported), needs_choice=sorted(unsupported),
                  race_groups=len(races), gender_groups=len(genders))
    return result
