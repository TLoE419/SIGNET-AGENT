args <- commandArgs(TRUE)
root <- normalizePath(args[1],mustWork=TRUE)
setwd(file.path(root,'res/resv'))
Sys.setenv(SIGNET_SCRIPT_ROOT=file.path(root,'script'),SIGNET_RESULT_ROOT=file.path(root,'res'),
           Afreq=file.path(root,'input/frequency'),coef=file.path(root,'input/coefficient'),
           genepos=file.path(root,'input/positions'),freq=args[2],ntop=args[3],id='9606',assembly='hg38',
           nchr='22',resv=file.path(root,'res/resv/signet'),cloud='T',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
# Follow the official netvis.sh sequence; only headless save/load is adapted.
source(file.path(root,'script/netvis/extract_edges.R'),local=.GlobalEnv)
source(file.path(root,'script/netvis/netshiny.R'),local=.GlobalEnv)
stopifnot(exists('ui'),exists('server'),is.function(server))
save.image(file=file.path(root,'official-session.RData'))
