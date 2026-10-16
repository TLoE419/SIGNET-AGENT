s6_enrichment_categories <- character()
s6_resource_root <- normalizePath(file.path(root,"resources"),mustWork=TRUE)
# Offline consumption of independently admitted byte snapshots. No network fallback.
s6_failed <- function(reason) {
  file.create(file.path(dirname(s6_resource_root), "official-failed"))
  cat("RESOURCE_REJECTED ", reason, "\n",sep="")
  stop(reason)
}
if (as.character(packageVersion("STRINGdb")) != "2.4.2") s6_failed("RESOURCE_PACKAGE_VERSION")
s6_resource <- function(name) {
  allowed <- c("version.tsv", "versions.tsv", "9606.protein.info.v12.0.txt.gz", "9606.protein.aliases.v12.0.txt.gz", "9606.protein.links.v12.0.txt.gz", "enrichment_KEGG.tsv", "enrichment_Process.tsv", "identifiers.txt")
  if (length(name) != 1 || !(name %in% allowed)) s6_failed("RESOURCE_PURPOSE")
  path <- file.path(s6_resource_root, name)
  if (!file.exists(path) || file.info(path)$size < 1) s6_failed("RESOURCE_MISSING")
  cat(paste0("RESOURCE_CONSUMED ", name, "\n"))
  path
}
s6_snapshot <- function(urlStr, oD) {
  names <- c("protein.info", "protein.aliases", "protein.links")
  urls <- paste0("https://stringdb-static.org/download/", names, ".v12.0/9606.", names, ".v12.0.txt.gz")
  if (length(urlStr) != 1 || !(urlStr %in% urls) || oD != s6_resource_root) s6_failed("RESOURCE_REQUEST")
  s6_resource(basename(urlStr))
}
s6_enrich <- function(urlStr, params, category) {
  if (!(category %in% c("KEGG", "Process")) || !identical(sort(names(params)), c("identifiers", "species")) || params$species != 9606) s6_failed("RESOURCE_QUERY")
  expected <- readLines(s6_resource("identifiers.txt"), warn=FALSE)
  actual <- strsplit(params$identifiers, "%0d", fixed=TRUE)[[1]]
  actual <- actual[nzchar(actual)]
  if (!setequal(actual, expected) || length(actual) != length(unique(actual))) {
    jsonlite::write_json(list(reason="RESOURCE_IDENTIFIERS",requested=actual,cached=expected,missingFromCache=setdiff(actual,expected),unusedCached=setdiff(expected,actual)),file.path(dirname(s6_resource_root),"resource-refusal.json"),auto_unbox=TRUE)
    s6_failed("RESOURCE_IDENTIFIERS")
  }
  s6_enrichment_categories <<- unique(c(s6_enrichment_categories,category))
  # stable_url is obtained from the admitted versions table, never contacted.
  if (urlStr != paste0(stable_url_for_s6, "/api/tsv/enrichment?")) s6_failed("RESOURCE_ENDPOINT")
  paste(readLines(s6_resource(paste0("enrichment_", category, ".tsv")), warn=FALSE), collapse="\n")
}

S6OfflineSTRINGdb <- methods::setRefClass("S6OfflineSTRINGdb", contains="STRINGdb", methods=list(
initialize = function (...) 
{
    "\nDescription:\n    Initiliazes STRING with a given version and species.\n    Checks the current version against the API and sets the \"take_first\" parameter. \n    \nAuthor(s):\n   Andrea Franceschini\n"
    initFields(...)
    if (length(species) == 0) {
        cat("WARNING: You didn't specify a species. Hence we will set 9606 (Homo Sapiens) as your species.\n")
        species <<- 9606
    }
    if (length(score_threshold) == 0) {
        cat("WARNING: Score threshold is not specified. We will be using medium stringency cut-off of 400.\n")
        score_threshold <<- 400
    }
    curr_version_table = read.table(s6_resource("version.tsv"), colClasses = "character")
    curr_version = curr_version_table$V1[1]
    if (length(version) == 0) {
        cat("WARNING: You didn't specify a version of the STRING database to use. Hence we will use STRING ", curr_version, 
            "\n")
        version <<- curr_version
    }
    else {
        if (!(grepl("\\.", version))) {
            version <<- paste(version, ".0", sep = "")
        }
    }
    version_available_table = read.table(s6_resource("versions.tsv"), colClasses = "character")
    valid_versions = version_available_table$V1
    if (!(version %in% valid_versions)) {
        cat("ERROR: specified version", version, " is not valid. \n")
        cat("Available versions:\n")
        print(valid_versions)
        stop()
    }
    file_version <<- version
    if (file_version == "11.0b") {
        file_version <<- "11.0"
    }
    stable_url <<- subset(version_available_table, V1 == version)$V2
    stable_url_for_s6 <<- stable_url
    if (input_directory == "" || is.null(input_directory) || length(input_directory) == 0) 
        input_directory <<- s6_resource_root
    if (input_directory == "" || is.null(input_directory) || length(score_threshold) == 0 || score_threshold < 1) 
        score_threshold <<- 1
    aliases_type <<- "take_first"
}
,
get_proteins = function () 
{
    "\nDescription:\n  Returns the STRING proteins data frame.\n  (it downloads and caches the information the first time that is called).\n\nAuthor(s):\n   Andrea Franceschini\n"
    if (nrow(proteins) == 0) {
        temp = s6_snapshot(paste("https://stringdb-static.org/download/protein.info.v", file_version, "/", species, 
            ".protein.info.v", file_version, ".txt.gz", sep = ""), oD = input_directory)
        if (version %in% c("11.0", "11.0b")) {
            proteinsDf <- read.table(temp, sep = "\t", header = TRUE, stringsAsFactors = FALSE, fill = TRUE, quote = "")
            proteinsDf2 = subset(proteinsDf, select = c("protein_external_id", "preferred_name", "protein_size", "annotation"))
        }
        else {
            proteinsDf <- read.table(temp, sep = "\t", skip = 1, header = FALSE, stringsAsFactors = FALSE, fill = TRUE, quote = "")
            colnames(proteinsDf) <- c("protein_external_id", "preferred_name", "protein_size", "annotation")
            proteinsDf2 = subset(proteinsDf, select = c("protein_external_id", "preferred_name", "protein_size", "annotation"))
        }
        proteins <<- proteinsDf2
    }
    return(proteins)
}
,
get_aliases = function (takeFirst = TRUE) 
{
    "\nDescription:\n  Loads and returns STRING alias table. \n\nAuthor(s):\n   Andrea Franceschini\n"
    if (takeFirst & aliases_type == "take_first" & nrow(aliases_tf) > 0) 
        return(aliases_tf)
    if (!takeFirst & aliases_type == "all" & nrow(aliases_tf) > 0) 
        return(aliases_tf)
    temp = s6_snapshot(paste("https://stringdb-static.org/download/protein.aliases.v", file_version, "/", species, 
        ".protein.aliases.v", file_version, ".txt.gz", sep = ""), oD = input_directory)
    if (!takeFirst) {
        aliases_type <<- "all"
    }
    else {
        aliases_type <<- "take_first"
    }
    if (takeFirst & aliases_type == "take_first" & nrow(aliases_tf) > 0) 
        return(aliases_tf)
    if (!takeFirst & aliases_type == "all" & nrow(aliases_tf) > 0) 
        return(aliases_tf)
    proteins <<- get_proteins()
    aliasDf <- read.table(temp, skip = 1, sep = "\t", header = FALSE, quote = "", stringsAsFactors = FALSE, fill = TRUE)
    colnames(aliasDf) <- c("STRING_id", "alias", "sources")
    aliasDf = subset(aliasDf, select = c("STRING_id", "alias"))
    pr1 = data.frame(STRING_id = proteins$protein_external_id, alias = proteins$preferred_name, stringsAsFactors = FALSE)
    pr2 = data.frame(STRING_id = proteins$protein_external_id, alias = proteins$protein_external_id, stringsAsFactors = FALSE)
    pr3 = data.frame(STRING_id = proteins$protein_external_id, alias = unlist(strsplit(proteins$protein_external_id, "\\."))[seq(from = 2, 
        to = 2 * nrow(proteins), by = 2)], stringsAsFactors = FALSE)
    if (takeFirst) {
        aliasDf = subset(aliasDf, !(toupper(iconv(alias, "WINDOWS-1252", "UTF-8")) %in% toupper(proteins$preferred_name)) & 
            !(toupper(iconv(alias, "WINDOWS-1252", "UTF-8")) %in% toupper(proteins$protein_external_id)) & !(toupper(iconv(alias, 
            "WINDOWS-1252", "UTF-8")) %in% toupper(unlist(strsplit(proteins$protein_external_id, "\\."))[seq(from = 2, to = 2 * 
            nrow(proteins), by = 2)])))
    }
    aliasDf2 = rbind(pr1, pr2, pr3, aliasDf)
    aliases_tf <<- aliasDf2
    return(aliasDf2)
}
,
load = function () 
{
    "\nDescription:\n  Downloads and returns the STRING network (the network is set also in the graph variable of the STRING_db object).\n  \nIt makes use of the variables:\n    \"backgroundV\"         vector containing STRING identifiers to be used as background \n                            (i.e. the STRING network loaded will contain only the proteins that are present also in this vector)\n    \"score_threshold\"     STRING combined score threshold (the network loaded contains only interactions having a combined score greater than this threshold)\n\nAuthor(s):\n   Andrea Franceschini\n"
    url <- paste("https://stringdb-static.org/download/protein.links.v", file_version, "/", species, ".protein.links.v", 
        file_version, ".txt.gz", sep = "")
    temp = s6_snapshot(url, oD = input_directory)
    cat("SIGNET_PHASE STRING-links-read-table begin\n")
    PPI <- read.table(temp, sep = " ", header = TRUE, stringsAsFactors = FALSE, fill = TRUE)
    cat("SIGNET_PHASE STRING-links-read-table end\n")
    PPIselected = PPI
    if (length(score_threshold) != 0) 
        PPIselected <- PPI[PPI$combined_score >= score_threshold, ]
    if (!is.null(backgroundV)) {
        PPIselected <- PPIselected[PPIselected$protein1 %in% backgroundV, ]
        PPIselected <- PPIselected[PPIselected$protein2 %in% backgroundV, ]
    }
    myg = graph.data.frame(PPIselected, FALSE)
    graph <<- myg
    return(myg)
}
,
get_enrichment = function (string_ids, category = "All", methodMT = NULL, iea = NULL, minScore = NULL) 
{
    "\nDescription:\n  Returns the enrichment for various annotation categories (among others Gene Ontology, KEGG, domains, Reference Publications) for a vector of STRING proteins.\n\nInput parameters:\n  \"string_ids\"    a vector of STRING identifiers.\n  \"category\" enrichment term category (All, Process, Component, Function, Keyword, KEGG, RCTM, Pfam, SMART, InterPro), default:ALL \n\nAuthor(s):\n   Andrea Franceschini\n"
    if (!(is.null(methodMT))) {
        warning("methodMT parameter is depecated. Only FDR correction is available.")
    }
    if (!(is.null(iea))) {
        warning("iea parameter is deprecated.")
    }
    if (!(is.null(minScore))) {
        warning("minScore parameter is deprecated.")
    }
    urlStr <- paste(stable_url, "/api/tsv/enrichment?", sep = "")
    string_ids = unique(string_ids)
    string_ids = string_ids[!is.na(string_ids)]
    identifiers = ""
    for (id in string_ids) {
        identifiers = paste(identifiers, id, "%0d", sep = "")
    }
    if (length(backgroundV) == 0) {
        params = list(species = species, identifiers = identifiers)
    }
    else {
        background = ""
        for (id in backgroundV) {
            background = paste(background, id, "%0d", sep = "")
        }
        params = list(species = species, identifiers = identifiers, background_string_identifiers = background)
    }
    tempDfv = s6_enrich(urlStr, params, category)
    ann = read.table(text = tempDfv, sep = "\t", stringsAsFactors = FALSE, quote = "", fill = TRUE, header = TRUE)
    requestedCategory = category
    if ((requestedCategory != "All") && (!is.null(requestedCategory))) {
        ann = subset(ann, category == requestedCategory)
    }
    return(ann)
}
))
